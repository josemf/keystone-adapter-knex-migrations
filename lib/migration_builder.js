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
        
        this._buildCurrentSchema();
        await this._loadCachedSchema();

        this._schemaCurrent.forEach((listSchema, listName) => {

            const listAdapter = this._listAdapters[listSchema.list];            
            const cachedSchema = this._schemaCached.get(listName);

            if(!cachedSchema) {

                // The doesn't exists as a table in the database
                // NOTE: It might be renamed--we should think of a clever way to take care of this
                
                this._createList(listSchema.list, listSchema.options, listSchema.fields);
                this._createAssociations(listAdapter, listAdapter.fieldAdapters.filter(f => f.fieldName === "Relationship"));                
            } else {

                const { addField, updateField, renameField, removeField } =  this._diffListFields(cachedSchema, listSchema);                               

                addField.forEach((fieldSchema, fieldIndex) => {
                    
                    if(fieldSchema.type === "Relationship") {
                        // If the field is a Relationship we should create a Association instead                        
                        //this._createAssociations(listAdapter, [ listAdapter.fieldAdaptersByPath[fieldSchema.target.name] ]);                                            
                    } else {
                        this._createField(fieldSchema.target.name, listSchema.list, { }, fieldSchema.target);
                    }                    
                });

                updateField.forEach(fieldSchema => {
                
                    if(fieldSchema.type === "Relationship") {

                    } else {
                        this._updateField(fieldSchema.name, listSchema.list, { }, fieldSchema.target, fieldSchema.source);
                    }                    
                });

                renameField.forEach(fieldSchema => {
                
                    if(fieldSchema.type === "Relationship") {

                    } else {
                        this._renameField(fieldSchema.name, listSchema.list, { }, fieldSchema.target, fieldSchema.source);
                    }                    
                });

                removeField.forEach(fieldSchema => {
                
                    if(fieldSchema.type === "Relationship") {

                    } else {
                        this._removeField(fieldSchema.name, listSchema.list, { }, fieldSchema.source);
                    }                    
                });                                
            }            
        });
        
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
            throw Error(`This is not implemented. For the time being make sure to add this list to your app configuration:

keystone.createList('InternalSchema', {
    schemaDoc: 'It keeps track of list schemas mapped to database, so we know how to compare database schemas without using introspection',
    fields: {
        content: { type: Text, schemaDoc: 'The schema contant as a JSON string' },
        createdAt: { type: DateTime, schemaDoc: 'The data time moment the schema have been applied to the database structure' }
    },
});
`);            
        }
        
        if(!await this._knex.schema.hasTable(this._options.cacheSchemaTableName)) {                        
            return;
        }

        const cachedSchemaResponse = await this._knex(this._options.cacheSchemaTableName).select("content").limit(1).orderBy("createdAt", "desc");

        if(cachedSchemaResponse.length === 0) {
            return;
        }

        const cachedSchemaLists = JSON.parse(cachedSchemaResponse[0].content);

        cachedSchemaLists.forEach(list => this._schemaCached.set(list.list, list));
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
            .filter(fieldAdapter => fieldAdapter.fieldName !== "Relationship")
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
                    ], fieldAdapter.field),

                    // This is required by Decimal and maybe others

                    this._buildOptions([
                        "knexOptions"
                    ], fieldAdapter)
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
    
    _createAssociations(listAdapter, fieldAdapters) {

        fieldAdapters
            .forEach(fieldAdapter => {

                const data = {
                    cardinality: fieldAdapter.rel.cardinality,
                    field: fieldAdapter.path,
                    target: {
                        list: fieldAdapter.field.refListKey,
                        referenced: fieldAdapter.field.refFieldPath
                    }
                };

                this._migration("association", "create", listAdapter.key, data);
            });        
    }

    _removeField(name, list, options, field) {
        this._migration("field", "remove", name, { list, options, field });
    }

    _removeAssociation(listAdapter, fieldAdapter) {

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
