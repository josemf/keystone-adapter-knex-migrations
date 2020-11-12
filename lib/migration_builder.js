const chalk = require('chalk');

const CliLog = require('./cli_log');

class MigrationBuilder {
    
    constructor(listAdapters, knex, options = { cacheSchemaTableName: "InternalSchema" }) {
        this._listAdapters = listAdapters;

        this._migrationsList = [];
        this._knex = knex;

        // Keeps the current working copy of the schema
        // This is what we want to represent in the database
        this._schemaCurrent = new Map();

        // Keeps the cached version of the schema. We will
        // have to fetch this from the DB and represents the
        // schema we have currently mapped in the DB
        this._schemaCached = new Map();

        this._options = options;

        this._log = new CliLog(options.spinner);
    }

    _logMigrations(migrations) {
        migrations.forEach(m => {
            this._log.object(m);
        });

        if(migrations.length === 0) {
            this._log.warn("No migrations generated. Database schema is up-to-date.");
        }
    }
    
    _areObjectsEqualRecursive(object1, object2) {
        
        if(Object.keys(object1).filter(k => typeof object1[k] !== "undefined").length
           !== Object.keys(object2).filter(k => typeof object2[k] !== "undefined").length) {
            
            return false;
        }
        
        const properties = Object.keys(object1);
        
        for(let i=0; i < properties.length; ++i) {

            const sourceFieldName = properties[i];            
                
            // This is mostly for Relationship renames
            // It's reasonable to accept a change of name for both side of the references
            // TODO: Have to fix this HACK for renames on both sides of the relationships
//            if(sourceFieldName === "referenced") continue;            
            
            if(typeof object1[sourceFieldName] === "object") {

                if(!this._areObjectsEqualRecursive(object1[sourceFieldName], object2[sourceFieldName])) {
                    return false;
                }
                
            } else if(object1[sourceFieldName] !== object2[sourceFieldName]) {
                return false;
            }
        }

        return true;        
    }
    
    _areFieldOptionsEqual(sourceField, targetField) {
        if(sourceField.type !== targetField.type) {
            return false;
        }

        const result = this._areObjectsEqualRecursive(sourceField, targetField);
        
        return result;
    }

    _prepareCompare(field, overrides = {}) {        
        return Object.assign({}, {
            options: Object.keys(field.options).reduce((a, key) => {

                if(key === "knexOptions") {
                    return a;
                }

                a[key] = field.options[key];
                
                return a;
            }, {}),
            type: field.type,
            cardinality: field.cardinality,
            reference: field.reference
        }, overrides);
    }
    
    _diffListFields(sourceList, targetList) {

        /*
          This is tricky. We follow an heuristic that might seem as gready as is explained as follow. 
          It starts by trying to find fields with same name and iterates
          a) Field exists in target list and options are same - no change
          b) Field exists in target list and options are different - it is an update
          c) Mark every field processed like this as DONE

          Taking all fields in sourceList in the original and filtering out all DONE fields. Iterate. At this point fields in sourceList
          Have different names than fields in targetList
          a) Next field from sourceList have similar options than field from target list - It is a rename
          b) Next field from sourceList have different options than field from target list.
            1) The target is a new field
            2) We should remove the source field. At this point we know there isn't a field with same name and the immediate target field is different
          c) There is a next field in sourceList but no field to iterate in targetList - it is a removed field
          d) There is no next field in sourceList but some more fields in targetList - those are added
        */
        
        const doneFieldNames = [];
 
        const addField    = [];
        const updateField = [];
        const renameField = [];        
        const removeField = []; 
        
        sourceList.fields.forEach(field => {

            const targetField = targetList.fields.find(targetField => field.name === targetField.name); 
            
            if(targetField) {
                if(!this._areFieldOptionsEqual(this._prepareCompare(field), this._prepareCompare(targetField))) {

                    if(field.type === "Relationship"
                       && this._areFieldOptionsEqual(this._prepareCompare(field, { reference: { list: field.reference.list} }), this._prepareCompare(targetField, { reference: { list: targetField.reference.list} }))) {

                        if(field.name !== targetField.name) {
                            renameField.push({ source: field, target: targetField });
                        }
                    } else {                    
                        updateField.push({ source: field, target: targetField });
                    }
                }
                
                doneFieldNames.push(field.name);
            }
        });
        
        const filteredSourceListFields = sourceList.fields.filter(field => !doneFieldNames.includes(field.name));
        const filteredTargetListFields = targetList.fields.filter(targetField => !doneFieldNames.includes(targetField.name));
        
        filteredSourceListFields.forEach((field, index) => {
            const targetField = filteredTargetListFields[index];

            if(!targetField) {
                removeField.push({ source: field });
            } else {
                
                if(this._areFieldOptionsEqual(this._prepareCompare(field), this._prepareCompare(targetField))) {                    
                    renameField.push({ source: field, target: targetField });
                } else {
                    addField.push({ target: targetField });
                    removeField.push({ source: field });
                }
            }
        });
        
        if(filteredTargetListFields.length > filteredSourceListFields.length) {
            for(let i=filteredSourceListFields.length; i < filteredTargetListFields.length; ++i) {
                const targetField = filteredTargetListFields[i];
                addField.push({ target: targetField });                
            }
        }
        
        return {
            addField,
            updateField,
            renameField,
            removeField
        };
    }    

    async buildRollback() {

        this._log.info("Using previous cached schema file for rollback");
        
        if(await this._loadCachedSchema(1, this._schemaCurrent)) {
            this._log.info("Loaded.");
        } else {
            this._log.warn("A database schema wasn't found to rollback. Noop.");
        }

        this._log.info("Loading latest cached schema file");

        const rollbackSchemaRow = await this._loadCachedSchema();
        
        if(rollbackSchemaRow) {
            this._log.info("Loaded.");
        } else {            
            this._log.error("A base schema wasn't found. It seems there are no migrations to rollback.");
        }
        
        const result = await this._build();
        
        result.id = rollbackSchemaRow.id;
        
        return result;
    }

    async buildForward() {

        this._log.info("Using current active cached schema for forward base");
        
        if(await this._loadCachedSchema()) {
            this._log.info("Loaded.");
        } else {            
            this._log.error("A base schema wasn't found. It seems there are no migrations to forward.");
        }

        this._log.info("Loading first inactive cached schema to forward to");

        const forwardSchemaRow = await this._loadCachedSchema(-1, this._schemaCurrent);
        
        if(forwardSchemaRow) {
            this._log.info("Loaded.");
        } else {
            this._log.info("There is no migrations to forward. Noop.");            
        }
        
        const result = await this._build();
        
        result.id = forwardSchemaRow.id;
        
        return result;
    }    

    async build() {

        this._log.info("Building schema file from current lists");
        
        this._buildCurrentSchema();        

        this._log.info("Loading database schema so we can build the differences");
        
        if(await this._loadCachedSchema()) {
            this._log.info("Loaded.");
        } else {
            this._log.warn("A database schema wasn't found. It is a new database.");
        }
        
        return await this._build();
    }
    
    async _build() {

        const currentListNames = [];
        
        this._schemaCurrent.forEach((listSchema, listName) => {            
            
            const listAdapter = this._listAdapters[listSchema.list];            
            const cachedSchema = this._schemaCached.get(listName);

            currentListNames.push(listName);
            
            if(!cachedSchema) {               
                
                // The doesn't exists as a table in the database
                // NOTE: It might be renamed--we should think of a clever way to take care of this
                             
                this._createList(listSchema.list, listSchema.options, listSchema.fields.filter(f => f.type !== "Relationship"));
                
                this._createAssociations(listSchema.list, listSchema.fields.filter(f => f.type === "Relationship"));                
            } else {
                
                const { addField, updateField, renameField, removeField } =  this._diffListFields(cachedSchema, listSchema);

                addField.forEach((fieldSchema, fieldIndex) => {
                    
                    if(fieldSchema.target.type === "Relationship") {                        
                        this._createAssociation(fieldSchema.target.name, listSchema.list,
                                                fieldSchema.target.cardinality, fieldSchema.target.reference,
                                                fieldSchema.target.left, fieldSchema.target.right);                                                
                    } else {
                        this._createField(fieldSchema.target.name, listSchema.list, { }, fieldSchema.target);
                    }                    
                });

                updateField.forEach(fieldSchema => {
                
                    if(fieldSchema.target.type === "Relationship") {
                        this._updateAssociation(fieldSchema.target.name, listSchema.list, { }, fieldSchema.target, fieldSchema.source);                        
                    } else {
                        this._updateField(fieldSchema.target.name, listSchema.list, { }, fieldSchema.target, fieldSchema.source);
                    }                    
                });

                renameField.forEach(fieldSchema => {
                
                    if(fieldSchema.target.type === "Relationship") {                        
                        this._renameAssociation(fieldSchema.target.name, listSchema.list, { }, fieldSchema.target, fieldSchema.source);
                    } else {
                        this._renameField(fieldSchema.target.name, listSchema.list, { }, fieldSchema.target, fieldSchema.source);
                    }                    
                });

                removeField.forEach(fieldSchema => {
                    
                    if(fieldSchema.source.type === "Relationship") {                        
                        this._removeAssociation(fieldSchema.source.name, listSchema.list,
                                                fieldSchema.source.cardinality, fieldSchema.source.reference,
                                                fieldSchema.source.left, fieldSchema.source.right);
                    } else {
                        this._removeField(fieldSchema.source.name, listSchema.list, { }, fieldSchema.source);
                    }                    
                });                                
            }            
        });

        // Check for list removals

        this._schemaCached.forEach((listSchema, cachedListName) => {

            if(!currentListNames.includes(cachedListName)) {
                this._removeList(listSchema.list, listSchema.options, listSchema.fields.filter(f => f.type !== "Relationship"));                
            }            
        });
        
        this._logMigrations(this._migrationsList);
        
        return {
            migrations: this._migrationsList,
            schema: Array.from(this._schemaCurrent.values()),
            id: undefined
        };
    }
    
    _forEachOfFields(change, diff, callback) {
        if(Object.keys(diff[change]).length > 0 && Object.keys(diff[change].fields).length > 0) {                    
            Object.keys(diff[change].fields).forEach(fieldIndex => {                
                const fieldSchema = diff[change].fields[fieldIndex];
                callback(fieldSchema, fieldIndex);
            });
        }                
    }
    
    _buildCurrentSchema() {

        Object.values(this._listAdapters).forEach(listAdapter => {

            const listSchema = this._buildList(listAdapter.key,
                                               Object.assign({}, { tableName: listAdapter.tableName }, listAdapter.config),
                                               this._buildFields(listAdapter.fieldAdapters));
            
            this._schemaCurrent.set(listAdapter.key, listSchema);
        });        
    }

    _buildList(name, options, fields) {
        return {
            list: name,
            options: options,
            fields: fields
        };
    }

    async _loadCachedSchema(countBefore = 0, targetMap = undefined)  {

        if(!this._listAdapters[this._options.cacheSchemaTableName]) {
            this._log.error(`This is not implemented. For the time being make sure to add this list to your app configuration`);
            
            this._log.warn(`
keystone.createList('InternalSchema', {
    schemaDoc: 'It keeps track of list schemas mapped to database, so we know how to compare database schemas without using introspection',
    fields: {
        content: { type: Text, schemaDoc: 'The schema contant as a JSON string' },
        createdAt: { type: DateTime, schemaDoc: 'The data time moment the schema have been applied to the database structure' }
    },
});
`);
            throw new Error();
        }
        
        if(!await this._knex.schema.hasTable(this._options.cacheSchemaTableName)) {                        
            return false;
        }

        let cachedSchemaResponse;
        if(countBefore >= 0) {        
            cachedSchemaResponse = await this._knex(this._options.cacheSchemaTableName).select(["id", "content"]).offset(countBefore).limit(1).orderBy("createdAt", "desc").where({ active: true });
        } else {
            cachedSchemaResponse = await this._knex(this._options.cacheSchemaTableName).select(["id", "content"]).offset((-countBefore) - 1).limit(1).orderBy("createdAt", "asc").where({ active: false });
        }
        
        if(cachedSchemaResponse.length === 0) {
            return false;
        }

        const cachedSchemaLists = JSON.parse(cachedSchemaResponse[0].content);

        cachedSchemaLists.forEach(list => targetMap ? targetMap.set(list.list, list) : this._schemaCached.set(list.list, list));
        
        return cachedSchemaResponse[0];
    }

    _tableInstrospectionChainables(chainables) {
        return new Proxy({}, {
            get: (target, prop, receiver) => {
                return (... args) => {
                    chainables.push({ name: prop, args: args });
                    return this._tableInstrospectionChainables(chainables);
                };
            }
        });
    }

    // There is the point of supporting as much as field adapters as we can including
    // third party ones. For that we introspect into `addToTableSchema` method on the field adapters
    // and set this value to the migration knexOptions object
    // I don't honestly like this solution since it makes the migration builder dependent on a knex
    // setting, but the alternative here would be map as much as keystone types to knex types and
    // default third party to Text type
    
    _tableIntrospectionProxy(callStack) {
        
        return new Proxy({}, {
            
            get: (target, prop, receiver) => {

                // Need to setup like this because some fields might be represented by two actual columns
                return (...args) => {
                    const fieldCallConfig = { method: prop, args: args, chainables: [] };

                    callStack.push(fieldCallConfig);
                    
                    return this._tableInstrospectionChainables(fieldCallConfig.chainables);                                        
                };
            },
            
            apply: function(target, thisArg, argumentsList) {
                // expected output: "Calculate sum: 1,2"
                
                return target(argumentsList[0], argumentsList[1]) * 10;
            }
        });
    }
    
    _buildOptions(keys, object) {
        return keys.reduce((options, key) => {

            if(typeof object[key] !== "undefined") {
                options[key] = object[key];
            }

            return options;
        }, {});
    }

    _buildFields(fieldAdapters) {

        return fieldAdapters
            .map(fieldAdapter => {
                let options = {};

                // This would be a lot easier if Field Adapters would store the original field definition
                
                if(fieldAdapter.fieldName !== "Relationship") {                                     
                    
                    options = Object.assign(

                        // Most cases lie here
                        this._buildOptions([
                            "isPrimaryKey",
                            "isRequired",
                            "defaultValue",
                            "dataType",
                            "options"
                        ], fieldAdapter.field),
                        
                        // This is required by Decimal and maybe others
                        
                        this._buildOptions([
                            "knexOptions",
                            "isUnique",
                            "isIndexed",
                            
                        ], fieldAdapter),
                        
                        this._buildOptions([
                            "cardinality",
                            "tableName",
                            "columnName"
                        ], fieldAdapter.rel || {})                        
                    );

                    const callStack = [];                
                    const introspect = this._tableIntrospectionProxy(callStack);
                    
                    fieldAdapter.addToTableSchema(introspect);
                    
                    options.knexOptions = Object.assign(options.knexOptions, { config: callStack });

                    return {
                        type: fieldAdapter.fieldName,
                        name: fieldAdapter.path,
                        options
                    };
                    
                } else {

                    // Associations are trickier ofc
                    options = Object.assign(

                        // Most cases lie here
                        this._buildOptions([
                            "isRequired",
                        ], fieldAdapter.field),

                        this._buildOptions([
                            "isUnique",
                            "isIndexed",
                        ], fieldAdapter)
                    );

                    return {
                        type: fieldAdapter.fieldName,
                        name: fieldAdapter.path,
                        cardinality: fieldAdapter.rel.cardinality,
                        reference: {
                            list: fieldAdapter.refListKey,
                            field: fieldAdapter.refFieldPath
                        },                        
                        left: {
                            list: fieldAdapter.rel.left.listKey,
                            field: fieldAdapter.rel.left.path,
                        },
                        right: {
                            list: fieldAdapter.rel.right ? fieldAdapter.rel.right.listKey : fieldAdapter.refListKey,
                            field: fieldAdapter.rel.right ? fieldAdapter.rel.right.path : undefined,
                        },
                        options
                    };                    
                }                
            });
    }

    _createList(name, options, fields) {
        this._migration("list", "create", name, { options, fields });
    }
 
    _removeList(name, options, fields) {
        this._migration("list", "remove", name, { options, fields });
    }   

    _createField(name, list, options, field) {
        this._migration("field", "create", name, { list, options, field });
    }

    _updateField(name, list, options, field, before) {
        this._migration("field", "update", name, { list, options, field, before });
    }

    _renameField(name, list, options, field, before) {
        this._migration("field", "rename", name, { list, options, field, before });
    }    

    _removeField(name, list, options, field) {
        this._migration("field", "remove", name, { list, options, field });
    }        
    
    _createAssociations(listName, fieldSchemas) {
        
        fieldSchemas
            .forEach(fieldSchema => {
                this._createAssociation(fieldSchema.name, listName,
                                        fieldSchema.cardinality, fieldSchema.reference,
                                        fieldSchema.left, fieldSchema.right);
            });        
    }

    _createAssociation(fieldName, tableName, cardinality, target, left, right) {
        
        const data = {
            cardinality: cardinality,
            field: fieldName,
            reference: target,
            left,
            right
        };
        
        this._migration("association", "create", tableName, data);
    }

    _updateAssociation(field, tableName, options, target, before) {
        this._migration("association", "update", tableName, { field, options, target, before });
    }
    
    _renameAssociation(fieldName, tableName, options, target, before) {
        this._migration("association", "rename", tableName, {
            options, field: fieldName, cardinality: target.cardinality, target, before
        });        
    }
        
    _removeAssociation(fieldName, tableName, cardinality, target, left, right) {
        
        const data = {
            cardinality: cardinality,
            field: fieldName,
            reference: target,
            left: left,
            right: right
        };
        
        this._migration("association", "remove", tableName, data);
    }    

    _removeField(name, list, options, field) {
        this._migration("field", "remove", name, { list, options, field });
    }
    
    _migration(object, op, name, extra = {}) {

        this._addMigrationPreventRelationshipDuplicates({
            object,
            op,
            name,
            ... extra
        });
        
    }

    _addMigrationPreventRelationshipDuplicates(migration) {
        
        if(migration.object === "association") {

            const reference = (migration.op === "update" || migration.op === "rename") ? (migration.target.reference.field ? migration.target.reference : migration.before.reference) : migration.reference;
            
            if(reference && reference.field) {

                let index;
                
                const referencedMigration = this._migrationsList.find((m, i) => {

                    index = i;
                    
                    return m.object === "association" && m.name === reference.list && m.field === reference.field;
                });

                if(referencedMigration) {

                    if(migration.op === "update" && referencedMigration.op !== "update") {
                        // This actually is the important scenario where a relationship create or remove is related to some
                        // cardinality change in the relationship, attributed to an update operation -- we need to preserve
                        // the update here
                                                
                        this._migrationsList.splice(index, 1, migration);
                    }
                    
                    return;
                }

            }
            
        } 

        this._migrationsList.push(migration);

    }
}

module.exports = MigrationBuilder;
