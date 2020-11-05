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
                await this._applyIf({ object: "association", op: "update" }, migration, () => this._updateAssociation(migration, referencedAssociationsState));                                
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
            const ops = [ "update", "create", "rename", "remove"];

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

        // We must handle unique and index separely

        await this._knex.schema.alterTable(tableName, (t) => {

            // We must handle unique and index separely                
            if(migration.before.options.isUnique === true &&
               migration.field.options.isUnique === false) {
                
                t.dropUnique(migration.name);
            }
            
            if(migration.before.options.isIndexed === true &&
               migration.field.options.isIndexed === false) {
                
                t.dropIndex(migration.name);
            }                            
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

    _getPivotTableName(table, column, referencesTable, referencedTargetField) {
        return referencedTargetField ? `${table}_${column}_${referencesTable}_${referencedTargetField}` : `${table}_${column}_many`;
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

            return {
                method: "field",
                table,
                column
            };
            
        } else {
            
            const pivotTableName = this._getPivotTableName(table, column, referencesTable, referencedTargetField = undefined);
                
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

            return {
                method: "pivotTable",                
                pivotTable: pivotTableName
            };
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

    async _updateAssociationCardinalitiesFromSingle_N1_to_NN(migration) {        
        await this._createAssociationRelationship(migration.target.options.left.list, migration.target.options.left.field, migration.target.options.right.list, "id", undefined, true);

        const pivotTable = this._getPivotTableName(migration.target.options.left.list, migration.target.options.left.field, migration.target.options.right.list);
        
        const rows = await this._knex.select().table(migration.target.options.left.list);
        const columnLeftId  = `${migration.target.options.left.list}_left_id`;
        const columnRightId = `${migration.target.options.right.list}_right_id`;        
        const columnForeignKey = migration.target.options.left.field;
        
        await this._knex.insert(rows.map(r => ({ [columnLeftId]: r.id, [columnRightId]: r[columnForeignKey] }))).into(pivotTable);
        
        await this._removeAssociationRelationship(migration.target.options.left.list, migration.target.options.left.field, migration.target.options.right.list);        
    }

    async _updateAssociationCardinalitiesFromSingle_NN_to_N1(migration) {
        await this._createAssociationRelationship(migration.target.options.left.list, migration.target.options.left.field, migration.target.options.right.list);

        const pivotTable = this._getPivotTableName(migration.target.options.left.list, migration.target.options.left.field, migration.target.options.right.list);
        const columnLeftId  = `${migration.target.options.left.list}_left_id`;
        const columnRightId = `${migration.target.options.right.list}_right_id`;                        
        
        // Postgres have a SELECT distinct on(field) that makes it possible not to have to load all records
        // Mysql we could use group by
        // Remember that we will lose some data here, if there are more than one association row to the left table
        const rows = await this._knex.select().table(pivotTable).orderBy(columnLeftId, "desc");
        
        const ids = {};
        
        for(let i=0; i < rows.length; ++i) {

            const r = rows[i];            
            
            if(true === ids[r[columnLeftId]]) continue;           
            
            await this._knex(migration.target.options.left.list)
                .where({ id: r[columnLeftId] })
                .update({ [migration.target.options.left.field]: r[columnRightId] });

            ids[r[columnLeftId]] = true;
        }

        await this._removeAssociationRelationship(migration.target.options.left.list, migration.target.options.left.field, migration.target.options.right.list, undefined, true);
    }    

    async _updateAssociationCardinalitiesFromSingle_N1_to_Referenced_1N(migration, referencedAssociationsState) {
        // This one implies that no database operation takes place AND that a create relationship migration exists for
        // the other side of the relationship.
        // So what we do is to prevent that association to be created

        const referencedMigrationIndex = `${migration.name}__${migration.field}`;
        const referencedMigration = referencedAssociationsState[referencedMigrationIndex];
        
        referencedMigration.takenCare = true;
    }

    async _updateAssociationCardinalitiesFromReferenced_1N_to_Single_N1(migration, referencedAssociationsState) {
        // Same as _updateAssociationCardinalitiesFromSingle_N1_to_Referenced_1N but in the other direction
        // Now we are disabling a association removal

        const referencedMigrationIndex = `${migration.name}__${migration.field}`;
        const referencedMigration = referencedAssociationsState[referencedMigrationIndex];
        
        referencedMigration.takenCare = true;

        // TODO: IMPLEMENTING THIS
    }
    
    async _updateAssociationCardinalities(migration, referencedAssociationsState) {

        /* This will be a one by one scenario. There are 20 combination on cardinality changes and while
         some wont require actual changes to the schema, in others we might change columns to pivot tables and try
         to copy data around.
         
         There is also the risk of truncating data in scenarios like N:N => N:1  and N:1 => 1:1
         
         So every case is a special case and we're handling this in separate 
        */
        
        if(!migration.before.options.target.referenced && migration.before.options.cardinality === "N:1") {            
            if(!migration.target.options.target.referenced && migration.target.options.cardinality === "N:N") {
                await this._updateAssociationCardinalitiesFromSingle_N1_to_NN(migration);
            }

            if(migration.before.options.target.referenced && migration.target.options.cardinality === "1:N") {
                await this._updateAssociationCardinalitiesFromSingle_N1_to_Referenced_1N(migration, referencedAssociationsState);
            }                        
        }

        if(!migration.before.options.target.referenced && migration.before.options.cardinality === "N:N") {
            if(!migration.target.options.target.referenced && migration.target.options.cardinality === "N:1") {
                await this._updateAssociationCardinalitiesFromSingle_NN_to_N1(migration);
            }                        
        }

        if(migration.before.options.target.referenced && migration.target.options.cardinality === "1:N") {
            if(!migration.before.options.target.referenced && migration.before.options.cardinality === "N:1") {                        
                await this._updateAssociationCardinalitiesFromReferenced_1N_to_Single_N1(migration, referencedAssociationsState);
            }
        }        
    }
    
    async _updateAssociation(migration, referencedAssociationsState) {
        await this._updateAssociationCardinalities(migration, referencedAssociationsState);
    }
    
    async _renameAssociationRelationship(table, column, referencesTable, beforeColumn, referencedTargetField = undefined, pivotTableMode = false, pivotTablePreviousColumn) {

        if(!pivotTableMode) {
            await this._knex.schema.table(table, (t) => {
                t.renameColumn(beforeColumn, column);                                                        
            });                
            
        } else {
            const beforeTableName = referencedTargetField ? `${table}_${beforeColumn}_${referencesTable}_${pivotTablePreviousColumn}` : `${table}_${beforeColumn}_many`;
            const pivotTableName  = referencedTargetField ? `${table}_${column}_${referencesTable}_${referencedTargetField}` : `${table}_${column}_many`;

            if(beforeTableName !== pivotTableName) {
                await this._knex.schema.renameTable(beforeTableName, pivotTableName);
            }
        }                
    }

    async _renameAssociation(migration, referencedAssociationsState) {

        if(!migration.target.referenced) {
            
            if(migration.cardinality === "N:1") {
                await this._renameAssociationRelationship(migration.left.list, migration.left.field, migration.right.list, migration.before.name);                
            }

            if(migration.cardinality === "N:N") {
                await this._renameAssociationRelationship(migration.left.list, migration.left.field, migration.right.list, migration.before.name, undefined, true);
            }
            
        } else {
            
            const referencedMigration    = referencedAssociationsState[`${migration.target.list}__${migration.target.referenced}`];
            const ownReferencedMigration = referencedAssociationsState[`${migration.name}__${migration.field}`];
            
            if(referencedMigration.takenCare) {                                
                return;
            }
            
            if(migration.cardinality === "1:1" || migration.cardinality === "N:1") {
                
                if(migration.name !== migration.left.list || migration.field === migration.before.name) {

                    ownReferencedMigration.takenCare = true;            
                    
                    // We don't have a real change in foreign keys in this scenario
                    return;
                }

                await this._renameAssociationRelationship(migration.left.list, migration.left.field, migration.right.list, migration.before.name);                                
            }

            if(migration.cardinality === "1:N") {
                
                if(migration.name !== migration.right.list || migration.field === migration.before.name) {

                    ownReferencedMigration.takenCare = true;            
                    
                    // We don't have a real change in foreign keys in this scenario
                    return;
                }

                await this._renameAssociationRelationship(migration.right.list, migration.right.field, migration.left.list, migration.before.name);                

            }
                        
            if(migration.cardinality === "N:N") {
                await this._renameAssociationRelationship(migration.left.list, migration.left.field, migration.right.list, migration.before.options.left.field, migration.right.field, true, migration.before.options.right.field);
            }

            ownReferencedMigration.takenCare = true;            
        }        
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
