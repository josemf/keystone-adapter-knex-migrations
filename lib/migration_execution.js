class MigrationExecution {
    constructor(listAdapters, knex, options = { cacheSchemaTableName: "InternalSchema" }) {
        this._knex = knex;
        this._listAdapters = listAdapters;

        this._options = options;

    }

    async apply(migrations, schema) {

        // Keeps track of relationships migrations when both side
        // of the associations depend on the "other" migration data       
        const referencedAssociationsState = this._buildReferencedAssociationsState(migrations);        
        const orderedMigrations = this._sortMigrations(migrations);
        
        for(const migration of orderedMigrations) {
            await this._applyIf({ object: "list", op: "create" }, migration, () => this._createTable(migration));
            await this._applyIf({ object: "association", op: "create" }, migration, () => this._createAssociation(migration, referencedAssociationsState));
            await this._applyIf({ object: "field", op: "create" }, migration, () => this._createField(migration));
            await this._applyIf({ object: "field", op: "update" }, migration, () => this._updateField(migration));
            await this._applyIf({ object: "field", op: "rename" }, migration, () => this._renameField(migration));
            await this._applyIf({ object: "field", op: "remove" }, migration, () => this._removeField(migration));            
        };

        await this._saveFreshDatabaseSchema(schema);        
    }

    _buildReferencedAssociationsState(migrations) {

        return migrations
            .filter(m => m.object === "association")
            .reduce((a, m) => {
                if(m.target.referenced) {
                    a[`${m.name}__${m.field}`] = {
                        takenCare:  false,                        
                        migration: m
                    };
                }

                return a;
            }, {});
    }
    
    _sortMigrations(migrations) {
        // This will sort migrations so create tables go first, remove tables second, fields add or remove third and foreign keys or indexes last
        return migrations.sort((m1, m2) => {

            const objects = [ "list", "field", "association" ];
            const ops = [ "create", "update", "rename", "remove"];

            if(objects.indexOf(m1.object) < objects.indexOf(m2.object)) {
                return -1;
            }

            if(objects.indexOf(m1.object) > objects.indexOf(m2.object)) {
                return 1;
            }

            if(ops.indexOf(m1.op) < ops.indexOf(m2.op)) {
                return -1;
            }

            if(ops.indexOf(m1.op) > ops.indexOf(m2.op)) {
                return 1;
            }

            return 0;
        });
    }

    async _applyIf({ object, op }, migration, callback) {
        if(migration.object === object && migration.op === op) {
            return await callback();
        }

        return Promise.resolve();
    }

    async _saveFreshDatabaseSchema(schema) {
        await this._knex
            .insert({ content: schema, createdAt: new Date() })
            .into(this._options.cacheSchemaTableName);
    }
    
    async _createTable(migration) {

        const tableName = migration.options.tableName || migration.name;

        if(await this._knex.schema.hasTable(tableName)) {

            console.log(`* ${tableName} table already exists in the database. Droping.`);
            
            await this._dropTable(migration);
        }

        console.log(`* Creating table ${tableName}`);
        
        await this._knex.schema.createTable(tableName, (t) => {
            
            migration.fields.forEach(field => {
                this._listAdapterFieldAddToTableSchema(migration.name, field, t, migration);
            });
        });
    }

    async _createField(migration) {

        console.log(`* Creating field ${migration.field.name} on table ${migration.list}`);

        const tableName = migration.list;
        
        await this._knex.schema.alterTable(tableName, (t) => {
            this._listAdapterFieldAddToTableSchema(migration.list, migration.field, t, migration);            
        });
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
    
    async _updateField(migration) {

        const tableName = migration.list;

        // We need to fool keystone into supplying the table column spec into the alter table
        // stament. The problem here is that the addToTableSchema methods wont return the knex table instance
        // making impossible to invoke "alter" on the result
        // Lets make a chainable Proxy so we can execute this the same way they do

        const callStack = [];
        
        const introspect = this._tableIntrospectionProxy(callStack);
        
        this._listAdapterFieldAddToTableSchema(migration.list, migration.field, introspect, migration);                    

        await this._knex.schema.alterTable(tableName, (t) => {
            callStack.forEach(alterFieldCall => {
                t = t[alterFieldCall.method](... alterFieldCall.args);

                alterFieldCall.chainables.forEach(chainable => {
                    t = t[chainable.name](... chainable.args);
                });

                t = t.alter();
            });
        });
        
        
        console.log(`* Updating column ${migration.field.name} on table ${migration.list}`);

    }

    async _renameField(migration) {

        const tableName = migration.list;

        console.log(`* Renaming column ${migration.before.name} to ${migration.field.name} on table ${migration.list}`);
        
        await this._knex.schema.alterTable(tableName, (t) => {
            t.renameColumn(migration.before.name, migration.field.name);
        });
    }

    async _removeField(migration) {

        const tableName = migration.list;

        console.log(`* Removing column ${migration.field.name} on table ${migration.list}`);
        
        await this._knex.schema.alterTable(tableName, (t) => {
            t.dropColumn(migration.field.name);
        });
    }    

    async _createAssociation(migration, referencedAssociationsState) {

        console.log(`* Creating association refering table ${migration.name} and field ${migration.field} refering to table ${migration.target.list}`);

        if(!migration.target.referenced) {
            // Standalone reference

            if(migration.cardinality === "N:1") {

                // Foreign key field goes to the list that declares a relationship
                
                await this._knex.schema.table(migration.name, (t) => {
                    t.integer(migration.field).unsigned();
                    // TODO: This might be required, or unique or whatever
                    t.index(migration.field);
                    t.foreign(migration.field)
                    // TODO: Need to handle those scenarios ids might be
                    // setup differently
                        .references("id")
                        .inTable(migration.target.list);
                });                
            }

            if(migration.cardinality === "N:N") {

                // We create a Pivot table with name `<TableName>_<fieldName>_many`
                // With fields <TableName>_left_id and <TargetTableName>_right_id

                const pivotTableName = `${migration.name}_${migration.field}_many`;
                
                await this._knex.schema.createTable(pivotTableName, (t) => {

                    const leftFieldName = `${migration.name}_left_id`;                    
                    t.integer(leftFieldName);
                    t.index(leftFieldName);
                    t.foreign(leftFieldName)
                        .references("id")
                        .inTable(migration.name);

                    const rightFieldName = `${migration.target.list}_right_id`;                    
                    t.integer(rightFieldName);
                    t.index(rightFieldName);
                    t.foreign(rightFieldName)
                        .references("id")
                        .inTable(migration.target.list);                                        
                });
                
            }
        } else {

            const referencedMigration    = referencedAssociationsState[`${migration.target.list}__${migration.target.referenced}`];
            const ownReferencedMigration = referencedAssociationsState[`${migration.name}__${migration.field}`];

            if(referencedMigration.takenCare) {
                // This was already caried out
                return;
            }
            
            if(migration.cardinality === "1:1" || migration.cardinality === "N:1") {
                // Foreign key field goes to the list that declares a relationship
                                
                await this._knex.schema.table(migration.name, (t) => {
                    t.integer(migration.field).unsigned();
                    t.index(migration.field);
                    t.foreign(migration.field)
                        .references("id")
                        .inTable(migration.target.list);
                });

                ownReferencedMigration.takenCare = true;
            }

            if(migration.cardinality === "1:N") {
                // Foreign key goes to target list

                await this._knex.schema.table(migration.target.list, (t) => {
                    t.integer(referencedMigration.migration.field).unsigned();
                    t.index(referencedMigration.migration.field);
                    t.foreign(referencedMigration.migration.field)
                        .references("id")
                        .inTable(migration.name);
                });

                ownReferencedMigration.takenCare = true;
            }

            if(migration.cardinality === "N:N") {
                // This is implemented with a Pivot table `<SourceTable>_<field>_<TargetTable>_<field>`

                const pivotTableName = `${migration.name}_${migration.field}_${referencedMigration.migration.name}_${referencedMigration.migration.field}`;
                
                await this._knex.schema.createTable(pivotTableName, (t) => {

                    const leftFieldName = `${migration.name}_left_id`;                    
                    t.integer(leftFieldName);
                    t.index(leftFieldName);
                    t.foreign(leftFieldName)
                        .references("id")
                        .inTable(migration.name);

                    const rightFieldName = `${referencedMigration.migration.name}_right_id`;                    
                    t.integer(rightFieldName);
                    t.index(rightFieldName);
                    t.foreign(rightFieldName)
                        .references("id")
                        .inTable(referencedMigration.migration.name);                                        
                });

                ownReferencedMigration.takenCare = true;                
            }
        }
    }

    async _dropTable(migration) {

        const tableName = migration.options.tableName || migration.name;

        await this._knex.schema.dropTableIfExists(tableName);
    }

    _listAdapterFieldAddToTableSchema(listName, field, t, m) {

        // I would prefer to build this listAdapter from scratch and feed the
        // options from the `migration<m>` itself but as a "compromise" feeding from
        // the list working copy is good enough for now--I might have to rebuild the
        // field composition from scratch        
        const fieldAdapter = this._listAdapters[listName].fieldAdaptersByPath[field.name];
        fieldAdapter.addToTableSchema(t);
    } 
}

module.exports = MigrationExecution;
