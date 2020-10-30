const CliLog = require('./cli_log');

class MigrationExecution {
    constructor(listAdapters, knex, options = { cacheSchemaTableName: "InternalSchema" }) {
        this._knex = knex;
        this._listAdapters = listAdapters;

        this._options = options;

        this._log = new CliLog(options.spinner);        
    }

    async apply(migrations, schema) {

        // Keeps track of relationships migrations when both side
        // of the associations depend on the "other" migration data       
        const referencedAssociationsState = this._buildReferencedAssociationsState(migrations);        
        const orderedMigrations = this._sortMigrations(migrations);

        this._log.info(`Starting to apply migrations`);

        if(orderedMigrations.length > 0) {
            
            for(const migration of orderedMigrations) {                               
                await this._applyIf({ object: "list", op: "create" }, migration, () => this._createTable(migration));
                await this._applyIf({ object: "field", op: "create" }, migration, () => this._createField(migration));
                await this._applyIf({ object: "field", op: "update" }, migration, () => this._updateField(migration));
                await this._applyIf({ object: "field", op: "rename" }, migration, () => this._renameField(migration));
                await this._applyIf({ object: "field", op: "remove" }, migration, () => this._removeField(migration));
                await this._applyIf({ object: "association", op: "create" }, migration, () => this._createAssociation(migration, referencedAssociationsState));
                await this._applyIf({ object: "association", op: "rename" }, migration, () => this._renameAssociation(migration, referencedAssociationsState));                
                await this._applyIf({ object: "association", op: "remove" }, migration, () => this._removeAssociation(migration, referencedAssociationsState));                                
            };

            await this._saveFreshDatabaseSchema(schema);
        } else {
            this._log.warn(`No migrations where found on path. Have you run "npx keystone-knex migrations-create"?`);
        }
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

                    const targetKey = `${m.target.list}__${m.target.referenced}`;

                    if(a[targetKey]) {
                        return a;
                    }

                    a[targetKey] = {
                        takenCare:  false,                        
                        migration: {
                            object: m.object, 
                            op: m.op,
                            name: m.target.list,
                            cardinality: m.cardinality,
                            field: m.target.referenced,
                            target: {
                                list: m.name,
                                referenced: m.field
                            }
                        }
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

            this._log.info(`Migrating:`);
            this._log.object(migration);

            if(!await this._log.confirm("Can you confirm?")) {
                this._log.warn("Skipped.");
                return;
            }

            const result = await callback();

            this._log.info("Migrated.");
            
            return result;
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

/*
        
        if(await this._knex.schema.hasTable(tableName)) {
            await this._dropTable(migration);
        }

*/        
        await this._knex.schema.createTable(tableName, (t) => {
            
            migration.fields.forEach(field => {
                this._listAdapterFieldAddToTableSchema(migration.name, field, t, migration);
            });
        });
    }

    async _createField(migration) {

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
    }

    async _renameField(migration) {

        const tableName = migration.list;
        
        await this._knex.schema.alterTable(tableName, (t) => {
            t.renameColumn(migration.before.name, migration.field.name);
        });
    }

    async _removeField(migration) {

        const tableName = migration.list;
        
        await this._knex.schema.alterTable(tableName, (t) => {
            t.dropColumn(migration.field.name);
        });
    }    

    async _createAssociationRelationship(table, column, referencesTable, foreignkeyTargetColumn = "id", referencedTargetField = undefined, pivotTableMode = false) {

        if(!pivotTableMode) {        
            await this._knex.schema.table(table, (t) => {
                t.integer(column).unsigned();
                // TODO: This might be required, or unique or whatever
                t.index(column);
                t.foreign(column)
                    .references(foreignkeyTargetColumn)
                    .inTable(referencesTable);
            });
            
        } else {
            
            const pivotTableName = referencedTargetField ? `${table}_${column}_${referencesTable}_${referencedTargetField}` : `${table}_${column}_many`;
                
            await this._knex.schema.createTable(pivotTableName, (t) => {

                const leftFieldName = `${table}_left_id`;                    
                t.integer(leftFieldName);
                t.index(leftFieldName);
                t.foreign(leftFieldName)
                    .references("id")
                    .inTable(table);
                
                const rightFieldName = `${referencesTable}_right_id`;                    
                t.integer(rightFieldName);
                t.index(rightFieldName);
                t.foreign(rightFieldName)
                    .references("id")
                    .inTable(referencesTable);                                        
            });            
        }
    }
    
    async _createAssociation(migration, referencedAssociationsState) {
        
        if(!migration.target.referenced) {
            // Standalone reference

            if(migration.cardinality === "N:1") {                
                await this._createAssociationRelationship(migration.left.list, migration.left.field, migration.right.list);
            }

            if(migration.cardinality === "N:N") {
                await this._createAssociationRelationship(migration.left.list, migration.left.field, migration.right.list, "id", undefined, true);
            }
        } else {

            const referencedMigration    = referencedAssociationsState[`${migration.target.list}__${migration.target.referenced}`];
            const ownReferencedMigration = referencedAssociationsState[`${migration.name}__${migration.field}`];
                
            if(referencedMigration.takenCare) {                                
                // This was already caried out
                return;
            }
            
            if(migration.cardinality === "1:1" || migration.cardinality === "N:1") {
                await this._createAssociationRelationship(migration.left.list, migration.left.field, migration.right.list, "id");
            }

            if(migration.cardinality === "1:N") {
                await this._createAssociationRelationship(migration.right.list, migration.right.field, migration.left.list, "id");
            }

            if(migration.cardinality === "N:N") {
                await this._createAssociationRelationship(migration.left.list, migration.left.field, migration.right.list, "id", migration.right.field, true);
            }
            
            ownReferencedMigration.takenCare = true;                
            
        }
    }

    async _removeAssociationRelationship(table, column, referencesTable, referencedTargetField = undefined, pivotTableMode = false) {

        if(!pivotTableMode) {
            
            await this._knex.schema.table(table, (t) => {
                t.renameColumn(migration.before.name, migration.field.name);                                                        
            });                
            
        } else {
            const pivotTableName = referencedTargetField ? `${table}_${column}_${referencesTable}_${referencedTargetField}` : `${table}_${column}_many`;

            await this._knex.schema.renameTable(beforePivotTableName, pivotTableName);
        }                
    }

    async _renameAssociation(migration, referencedAssociationsState) {
        console.log(migration);

    }    

    async _removeAssociationRelationship(table, column, referencesTable, referencedTargetField = undefined, pivotTableMode = false) {

        if(!pivotTableMode) {
            await this._knex.schema.table(table, (t) => {
                t.dropColumn(column);
            });                
            
        } else {
            const pivotTableName = referencedTargetField ? `${table}_${column}_${referencesTable}_${referencedTargetField}` : `${table}_${column}_many`;            
            await this._knex.schema.dropTable(pivotTableName);            
        }                
    }
    
    async _removeAssociation(migration, referencedAssociationsState) {
        
        if(!migration.target.referenced) {
            
            if(migration.cardinality === "N:1") {
                await this._removeAssociationRelationship(migration.left.list, migration.left.field, migration.target.list);                
            }

            if(migration.cardinality === "N:N") {
                await this._removeAssociationRelationship(migration.left.list, migration.left.field, migration.target.list, migration.target.referenced, true);
            }
            
        } else {
            
            const referencedMigration    = referencedAssociationsState[`${migration.target.list}__${migration.target.referenced}`];
            const ownReferencedMigration = referencedAssociationsState[`${migration.name}__${migration.field}`];
            
            if(referencedMigration.takenCare) {                                
                return;
            }
            
            if(migration.cardinality === "1:1" || migration.cardinality === "N:1") {
                await this._removeAssociationRelationship(migration.left.list, migration.left.field, migration.right.list);
            }

            if(migration.cardinality === "1:N") {
                await this._removeAssociationRelationship(migration.right.list, migration.right.field, migration.right.list);
            }

            if(migration.cardinality === "N:N") {
                await this._removeAssociationRelationship(migration.left.list, migration.left.field, migration.right.list, migration.right.field, true);                
            }

            ownReferencedMigration.takenCare = true;            
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
