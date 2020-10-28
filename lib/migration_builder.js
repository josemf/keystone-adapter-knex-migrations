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
            this._log.warn("No migrations generated. Database schema is up-to-date.")
        }
    }
    
    _areObjectsEqualRecursive(object1, object2) {

        if(Object.keys(object1).length !== Object.keys(object2).length) {
            
            return false;
        }

        for(let sourceFieldName in object1) {
            if(object1.hasOwnProperty(sourceFieldName)) {

                if(typeof object1[sourceFieldName] !== typeof object2[sourceFieldName]) {
                    return false;
                }

                if(typeof object1[sourceFieldName] === "object") {
                    return this._areObjectsEqualRecursive(object1[sourceFieldName], object2[sourceFieldName]);
                }
                
                if(object1[sourceFieldName] !== object2[sourceFieldName]) {
                    return false;
                }
              }
        }

        return true;
        
    }
    
    _areFieldOptionsEqual(sourceField, targetField) {
        if(sourceField.type !== targetField.type) {
            return false;
        }

        return this._areObjectsEqualRecursive(sourceField.options, targetField.options);
        

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
                if(!this._areFieldOptionsEqual(field, targetField)) {
                    updateField.push({ source: field, target: targetField });
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
                if(this._areFieldOptionsEqual(field, targetField)) {
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
    
    async build() {

        this._log.info("Building lists schema file");
        
        this._buildCurrentSchema();        

        this._log.info("Loading database schema so we can build the differences");
        
        if(await this._loadCachedSchema()) {
            this._log.info("Loaded.");
        } else {
            this._log.warn("A database schema wasn't found. It is a new database.");
        }
        
        this._schemaCurrent.forEach((listSchema, listName) => {            
            
            const listAdapter = this._listAdapters[listSchema.list];            
            const cachedSchema = this._schemaCached.get(listName);

            if(!cachedSchema) {               
                
                // The doesn't exists as a table in the database
                // NOTE: It might be renamed--we should think of a clever way to take care of this
                             
                this._createList(listSchema.list, listSchema.options, listSchema.fields.filter(f => f.type !== "Relationship"));
                
                this._createAssociations(listSchema.list, listSchema.fields.filter(f => f.type === "Relationship") /* listAdapter.fieldAdapters.filter(f => f.fieldName === "Relationship") */);                
            } else {
                
                const { addField, updateField, renameField, removeField } =  this._diffListFields(cachedSchema, listSchema);
                
                addField.forEach((fieldSchema, fieldIndex) => {
                    
                    if(fieldSchema.target.type === "Relationship") {                        
                        this._createAssociation(fieldSchema.target.name, listSchema.list,
                                                fieldSchema.target.options.cardinality, fieldSchema.target.options.refListKey,
                                                fieldSchema.target.options.refFieldPath);                                                
                    } else {
                        this._createField(fieldSchema.target.name, listSchema.list, { }, fieldSchema.target);
                    }                    
                });

                updateField.forEach(fieldSchema => {
                
                    if(fieldSchema.target.type === "Relationship") {

                    } else {
                        this._updateField(fieldSchema.name, listSchema.list, { }, fieldSchema.target, fieldSchema.source);
                    }                    
                });

                renameField.forEach(fieldSchema => {
                
                    if(fieldSchema.target.type === "Relationship") {

                    } else {
                        this._renameField(fieldSchema.source.name, listSchema.list, { }, fieldSchema.target, fieldSchema.source);
                    }                    
                });

                removeField.forEach(fieldSchema => {
                    
                    if(fieldSchema.source.type === "Relationship") {                        
                        this._removeAssociation(fieldSchema.source.name, listSchema.list,
                                                fieldSchema.source.options.cardinality, fieldSchema.source.options.refListKey,
                                                fieldSchema.source.options.refFieldPath);                                                

                    } else {
                        this._removeField(fieldSchema.source.name, listSchema.list, { }, fieldSchema.source);
                    }                    
                });                                
            }            
        });
        
        this._logMigrations(this._migrationsList);
        
        return {
            migrations: this._migrationsList,
            schema: Array.from(this._schemaCurrent.values())
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

    async _loadCachedSchema()  {

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

        const cachedSchemaResponse = await this._knex(this._options.cacheSchemaTableName).select("content").limit(1).orderBy("createdAt", "desc");

        if(cachedSchemaResponse.length === 0) {
            return false;
        }

        const cachedSchemaLists = JSON.parse(cachedSchemaResponse[0].content);

        cachedSchemaLists.forEach(list => this._schemaCached.set(list.list, list));

        return true;
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

                // This would be a lot easier if Field Adapters would store the original field definition

                const options = Object.assign(

                    // Most cases lie here

                    this._buildOptions([
                        "isPrimaryKey",
                        "isRequired",
                        "isUnique",
                        "isIndexed",
                        "defaultValue",
                        "dataType",
                        "options",
                        "refListKey",
                        "refFieldPath"
                    ], fieldAdapter.field),

                    // This is required by Decimal and maybe others

                    this._buildOptions([
                        "knexOptions"
                    ], fieldAdapter),

                    this._buildOptions([
                        "cardinality"
                    ], fieldAdapter.rel || {})
                    
                );

                return {
                    type: fieldAdapter.fieldName,
                    name: fieldAdapter.path,
                    options
                };
            });
    }

    _createList(name, options, fields) {
        this._migration("list", "create", name, { options, fields });
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
                                        fieldSchema.options.cardinality, fieldSchema.options.refListKey,
                                        fieldSchema.options.refFieldPath);
            });        
    }

    _createAssociation(fieldName, tableName, cardinality, targetListName, referencedFieldName = undefined) {
        
        const data = {
            cardinality: cardinality,
            field: fieldName,
            target: {
                list: targetListName,
                referenced: referencedFieldName
            }
        };
        
        this._migration("association", "create", tableName, data);
    }

    _removeAssociation(fieldName, tableName, cardinality, targetListName, referencedFieldName = undefined) {
        
        const data = {
            cardinality: cardinality,
            field: fieldName,
            target: {
                list: targetListName,
                referenced: referencedFieldName
            }
        };
        
        this._migration("association", "remove", tableName, data);
    }    

    _removeField(name, list, options, field) {
        this._migration("field", "remove", name, { list, options, field });
    }
    
    _migration(object, op, name, extra = {}) {
        this._migrationsList.push({
            object,
            op,
            name,
            ... extra
        });
    }
}

module.exports = MigrationBuilder;
