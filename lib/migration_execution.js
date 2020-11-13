const CliLog = require('./cli_log');

class MigrationExecution {
    constructor(listAdapters, knex, options = { cacheSchemaTableName: "InternalSchema" }) {
        this._knex = knex;
        this._listAdapters = listAdapters;

        this._options = options;

        this._log = new CliLog(options.spinner);
    }

    async apply(migrations, schema, cmd = "create", cachedSchemaId = undefined) {

        // Keeps track of relationships migrations when both side
        // of the associations depend on the "other" migration data
        const orderedMigrations = this._sortMigrations(migrations);

        this._log.info(`Starting to apply migrations`);

        if(orderedMigrations.length > 0) {

            for(const migration of orderedMigrations) {
                await this._applyIf({ object: "list", op: "create" }, migration, () => this._createTable(migration));
                await this._applyIf({ object: "list", op: "remove" }, migration, () => this._removeTable(migration));
                await this._applyIf({ object: "field", op: "create" }, migration, () => this._createField(migration));
                await this._applyIf({ object: "field", op: "update" }, migration, () => this._updateField(migration));
                await this._applyIf({ object: "field", op: "rename" }, migration, () => this._renameField(migration));
                await this._applyIf({ object: "field", op: "remove" }, migration, () => this._removeField(migration));
                await this._applyIf({ object: "association", op: "create" }, migration, () => this._createAssociation(migration));
                await this._applyIf({ object: "association", op: "update" }, migration, () => this._updateAssociation(migration));
                await this._applyIf({ object: "association", op: "rename" }, migration, () => this._renameAssociation(migration));
                await this._applyIf({ object: "association", op: "remove" }, migration, () => this._removeAssociation(migration));
            };

            switch(cmd) {
            case "create":
                await this._saveFreshDatabaseSchema(schema);
                break;
            case "rollback":
                await this._disableCachedDatabaseSchema(cachedSchemaId);
                break;
            case "forward":
                await this._enableCachedDatabaseSchema(cachedSchemaId);
                break;
            }

        } else {
            this._log.warn(`No migrations where found on path. Have you run "npx keystone-knex migrations-create"?`);
        }
    }

    _sortMigrations(migrations) {
        // This will sort migrations so create tables go first, remove tables second, fields add or remove third and foreign keys or indexes last
        return migrations.sort((m1, m2) => {

            const objects = [ "list", "field", "association" ];
            const ops = [ "update", "create", "rename", "remove"];

            // This is the exception to the ordering rule I'm seeying
            // if we start to have other we should review this ordering function
            if(m1.object === "list" && m1.op === "remove"
               && m2.object === "association" && m2.op === "remove") {
                return 1;
            }

            if(m2.object === "list" && m2.op === "remove"
               && m1.object === "association" && m1.op === "remove") {
                return -1;
            }

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
                return null;
            }

            const result = await callback();

            this._log.info("Migrated.");

            return result;
        }

        return Promise.resolve();
    }

    async _disableCachedDatabaseSchema(id) {
        // Disable the rollback migration

        await this._knex(this._options.cacheSchemaTableName)
            .where({ id: id })
            .update({ active: false });
    }

    async _enableCachedDatabaseSchema(id) {
        // Disable the rollback migration

        await this._knex(this._options.cacheSchemaTableName)
            .where({ id: id })
            .update({ active: true });
    }

    async _saveFreshDatabaseSchema(schema) {
        await this._knex
            .insert({ content: schema, createdAt: new Date(), active: true })
            .into(this._options.cacheSchemaTableName);

        // Resets the rollback / forward history
        await this._knex(this._options.cacheSchemaTableName)
            .where('active', false)
            .delete();
    }

    async _createTable(migration) {

        const tableName = migration.options.tableName || migration.name;

        await this._knex.schema.createTable(tableName, (t) => {

            migration.fields.forEach(field => {
                this._listAdapterFieldAddToTableSchema(field, t);
            });
        });
    }

    async _removeTable(migration) {

        const tableName = migration.options.tableName || migration.name;

        await this._knex.schema.dropTable(tableName);
    }

    async _createField(migration) {

        const tableName = migration.list;

        await this._knex.schema.alterTable(tableName, (t) => {
            this._listAdapterFieldAddToTableSchema(migration.field, t);
        });
    }

    async _updateField(migration) {

        const tableName = migration.list;

        // We need to fool keystone into supplying the table column spec into the alter table
        // stament. The problem here is that the addToTableSchema methods wont return the knex table instance
        // making impossible to invoke "alter" on the result
        // Lets make a chainable Proxy so we can execute this the same way they do


        await this._knex.schema.alterTable(tableName, (t) => {
            this._listAdapterFieldAddToTableSchema(migration.field, t, true);
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
            // TODO: Use the knexOptions config
            t.renameColumn(migration.before.name, migration.field.name);
        });
    }

    async _removeField(migration) {

        const tableName = migration.list;
        const knexFieldColumnNames = migration.field.options.knexOptions.config.map(c => c.args[0]);

        await this._knex.schema.alterTable(tableName, (t) => {
            knexFieldColumnNames.forEach(columnName => t.dropColumn(columnName));
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

            const pivotTableName = this._getPivotTableName(table, column, referencesTable, referencedTargetField);

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

    async _createAssociation(migration) {

        if(!migration.reference.field) {
            // Standalone reference

            if(migration.cardinality === "N:1") {
                await this._createAssociationRelationship(migration.left.list, migration.left.field, migration.right.list);
            }

            if(migration.cardinality === "N:N") {
                await this._createAssociationRelationship(migration.left.list, migration.left.field, migration.right.list, "id", undefined, true);
            }
        } else {

            if(migration.cardinality === "1:1" || migration.cardinality === "N:1") {
                await this._createAssociationRelationship(migration.left.list, migration.left.field, migration.right.list, "id");
            }

            if(migration.cardinality === "1:N") {
                await this._createAssociationRelationship(migration.right.list, migration.right.field, migration.left.list, "id");
            }

            if(migration.cardinality === "N:N") {
                await this._createAssociationRelationship(migration.left.list, migration.left.field, migration.right.list, "id", migration.right.field, true);
            }
        }
    }

    async _updateAssociationCardinalitiesFromSingle_N1_to_NN(migration) {
        await this._createAssociationRelationship(migration.target.left.list, migration.target.left.field, migration.target.right.list, "id", undefined, true);

        const pivotTable = this._getPivotTableName(migration.target.left.list, migration.target.left.field, migration.target.right.list);

        const rows = await this._knex.select().table(migration.before.left.list);
        const columnLeftId  = `${migration.target.left.list}_left_id`;
        const columnRightId = `${migration.target.right.list}_right_id`;
        const columnForeignKey = migration.before.left.field;

        await this._knex.insert(rows.map(r => ({ [columnLeftId]: r.id, [columnRightId]: r[columnForeignKey] }))).into(pivotTable);

        await this._removeAssociationRelationship(migration.before.left.list, migration.before.left.field, migration.before.right.list);
    }

    async _updateAssociationCardinalitiesFromSingle_NN_to_N1(migration) {
        await this._createAssociationRelationship(migration.target.left.list, migration.target.left.field, migration.target.right.list);

        const pivotTable = this._getPivotTableName(migration.before.left.list, migration.before.left.field, migration.before.right.list);
        const columnLeftId  = `${migration.before.left.list}_left_id`;
        const columnRightId = `${migration.before.right.list}_right_id`;

        // Postgres have a SELECT distinct on(field) that makes it possible not to have to load all records
        // Mysql we could use group by
        // Remember that we will lose some data here, if there are more than one association row to the left table
        const rows = await this._knex.select().table(pivotTable);

        for(let i=0; i < rows.length; ++i) {

            const r = rows[i];

            await this._knex(migration.target.left.list)
                .where({ id: r[columnLeftId] })
                .update({ [migration.target.left.field]: r[columnRightId] });
        }

        await this._removeAssociationRelationship(migration.before.left.list, migration.before.left.field, migration.before.right.list, undefined, true);
    }

    async _updateAssociationCardinalitiesFromSingle_NN_to_Referenced_11(migration) {
        await this._createAssociationRelationship(migration.target.left.list, migration.target.left.field, migration.target.right.list);

        const pivotTable = this._getPivotTableName(migration.before.left.list, migration.before.left.field, migration.before.right.list);
        const columnLeftId  = `${migration.before.left.list}_left_id`;
        const columnRightId = `${migration.before.right.list}_right_id`;

        const rows = await this._knex.select().table(pivotTable);

        for(let i=0; i < rows.length; ++i) {

            const r = rows[i];

            if(migration.before.left.list === migration.target.left.list && migration.before.left.field === migration.target.left.field) {

                if(r[columnLeftId]) {
                    await this._knex(migration.target.left.list)
                        .where({ id: r[columnLeftId] })
                        .update({ [migration.target.left.field]: r[columnRightId] });
                }

            } else {

                if(r[columnRightId]) {
                    await this._knex(migration.target.left.list)
                        .where({ id: r[columnRightId] })
                        .update({ [migration.target.left.field]: r[columnLeftId] });

                }
            }
        }

        await this._removeAssociationRelationship(migration.before.left.list, migration.before.left.field, migration.before.right.list, undefined, true);
    }

    async _updateAssociationCardinalitiesFromReferenced_11_to_Single_NN(migration) {

        await this._createAssociationRelationship(migration.target.left.list, migration.target.left.field, migration.target.right.list, "id", undefined, true);

        const pivotTable = this._getPivotTableName(migration.target.left.list, migration.target.left.field, migration.target.right.list);

        const rows = await this._knex.select().table(migration.before.left.list);

        const columnLeftId  = `${migration.target.left.list}_left_id`;
        const columnRightId = `${migration.target.right.list}_right_id`;
        const columnForeignKey = migration.before.left.field;

        if(migration.before.left.list === migration.target.left.list && migration.before.left.field === migration.target.left.field) {
            await this._knex.insert(rows.map(r => ({ [columnLeftId]: r.id, [columnRightId]: r[columnForeignKey] }))).into(pivotTable);
        } else {
            await this._knex.insert(rows.map(r => ({ [columnRightId]: r.id, [columnLeftId]: r[columnForeignKey] }))).into(pivotTable);
        }

        await this._removeAssociationRelationship(migration.before.left.list, migration.before.left.field, migration.before.right.list);
    }

    async _updateAssociationCardinalitiesFromSingle_NN_to_Referenced_1N(migration) {

        await this._createAssociationRelationship(migration.target.right.list, migration.target.right.field, migration.target.left.list);

        const pivotTable = this._getPivotTableName(migration.before.left.list, migration.before.left.field, migration.before.right.list);
        const columnLeftId  = `${migration.before.left.list}_left_id`;
        const columnRightId = `${migration.before.right.list}_right_id`;

        const rows = await this._knex.select().table(pivotTable);

        for(let i=0; i < rows.length; ++i) {

            const r = rows[i];

            // This depends on where the foreign key goes
            if(migration.before.left.list === migration.target.right.list && migration.before.left.field === migration.target.right.field) {

                if(r[columnLeftId]) {
                    await this._knex(migration.target.right.list)
                        .where({ id: r[columnLeftId] })
                        .update({ [migration.target.right.field]: r[columnRightId] });
                }

            } else {

                if(r[columnRightId]) {
                    await this._knex(migration.target.right.list)
                        .where({ id: r[columnRightId] })
                        .update({ [migration.target.right.field]: r[columnLeftId] });

                }
            }
        }

        await this._removeAssociationRelationship(migration.before.left.list, migration.before.left.field, migration.before.right.list, undefined, true);
    }

    async _updateAssociationCardinalitiesFromReferenced_1N_to_Single_NN(migration) {

        await this._createAssociationRelationship(migration.target.left.list, migration.target.left.field, migration.target.right.list, "id", undefined, true);

        const pivotTable = this._getPivotTableName(migration.target.left.list, migration.target.left.field, migration.target.right.list);

        const rows = await this._knex.select().table(migration.before.right.list);

        const columnLeftId  = `${migration.target.left.list}_left_id`;
        const columnRightId = `${migration.target.right.list}_right_id`;
        const columnForeignKey = migration.before.right.field;

        // This depends on where the foreign key goes
        if(migration.before.right.list === migration.target.left.list && migration.before.right.field === migration.target.left.field) {
            await this._knex.insert(rows.map(r => ({ [columnLeftId]: r.id, [columnRightId]: r[columnForeignKey] }))).into(pivotTable);
        } else {
            await this._knex.insert(rows.map(r => ({ [columnRightId]: r.id, [columnLeftId]: r[columnForeignKey] }))).into(pivotTable);
        }

        await this._removeAssociationRelationship(migration.before.right.list, migration.before.right.field, migration.before.left.list);
    }

    async _updateAssociationCardinalitiesFromSingle_NN_to_Referenced_N1(migration) {

        // This is actually same code as _updateAssociationCardinalitiesFromSingle_NN_to_Referenced_11

        await this._createAssociationRelationship(migration.target.left.list, migration.target.left.field, migration.target.right.list);

        const pivotTable = this._getPivotTableName(migration.before.left.list, migration.before.left.field, migration.before.right.list);
        const columnLeftId  = `${migration.before.left.list}_left_id`;
        const columnRightId = `${migration.before.right.list}_right_id`;

        const rows = await this._knex.select().table(pivotTable);

        for(let i=0; i < rows.length; ++i) {

            const r = rows[i];

            if(migration.before.left.list === migration.target.left.list && migration.before.left.field === migration.target.left.field) {

                if(r[columnLeftId]) {
                    await this._knex(migration.target.left.list)
                        .where({ id: r[columnLeftId] })
                        .update({ [migration.target.left.field]: r[columnRightId] });
                }

            } else {

                if(r[columnRightId]) {
                    await this._knex(migration.target.left.list)
                        .where({ id: r[columnRightId] })
                        .update({ [migration.target.left.field]: r[columnLeftId] });
                }
            }
        }

        await this._removeAssociationRelationship(migration.before.left.list, migration.before.left.field, migration.before.right.list, undefined, true);
    }

    async _updateAssociationCardinalitiesFromReferenced_N1_to_Single_NN(migration) {

        // This is actually same code as _updateAssociationCardinalitiesFromReferenced_11_to_Single_NN

        await this._createAssociationRelationship(migration.target.left.list, migration.target.left.field, migration.target.right.list, "id", undefined, true);

        const pivotTable = this._getPivotTableName(migration.target.left.list, migration.target.left.field, migration.target.right.list);

        const rows = await this._knex.select().table(migration.before.left.list);

        const columnLeftId  = `${migration.target.left.list}_left_id`;
        const columnRightId = `${migration.target.right.list}_right_id`;
        const columnForeignKey = migration.before.left.field;

        if(migration.before.left.list === migration.target.left.list && migration.before.left.field === migration.target.left.field) {
            await this._knex.insert(rows.map(r => ({ [columnLeftId]: r.id, [columnRightId]: r[columnForeignKey] }))).into(pivotTable);
        } else {
            await this._knex.insert(rows.map(r => ({ [columnRightId]: r.id, [columnLeftId]: r[columnForeignKey] }))).into(pivotTable);
        }

        await this._removeAssociationRelationship(migration.before.left.list, migration.before.left.field, migration.before.right.list);
    }

    async _updateAssociationCardinalitiesFlipForeignKeys(migration, targetLeft, targetRight, beforeLeft, beforeRight) {

        if(targetLeft.list !== beforeLeft.list || targetLeft.field !== beforeLeft.field) {

            // It might happen that in S N:1 => C 1:1 scenario the initial foreign key comes from the second defined
            // list in case we don't need to change the key

            await this._createAssociationRelationship(targetLeft.list, targetLeft.field, targetRight.list);

            const rows = await this._knex.select().table(beforeLeft.list);

            for(let i=0; i < rows.length; ++i) {

                const r = rows[i];

                if(r[beforeLeft.field]) {
                    await this._knex(targetLeft.list)
                        .where({ id: r[beforeLeft.field] })
                        .update({ [targetLeft.field]: r['id'] });
                }
            }

            await this._removeAssociationRelationship(beforeLeft.list, beforeLeft.field, beforeRight.list);
        }
    }

    async _updateAssociationCardinalitiesFromSingle_N1_to_Referenced_11(migration) {
        // In this scenario we have to flip the side of the foreign key and try to migrate the data from one
        // side to the other, disabling the the remove migration from the other direction

        await this._updateAssociationCardinalitiesFlipForeignKeys(migration, migration.target.left, migration.target.right, migration.before.left, migration.before.right);
    }

    async _updateAssociationCardinalitiesFromReferenced_11_to_Single_N1(migration) {
        // We flip the foreign keys and try to migrate data around

        await this._updateAssociationCardinalitiesFlipForeignKeys(migration, migration.target.left, migration.target.right, migration.before.left, migration.before.right);
    }

    async _updateAssociationCardinalitiesFromSingle_N1_to_Referenced_N1(migration) {
        // We flip the foreign keys and try to migrate data around

        await this._updateAssociationCardinalitiesFlipForeignKeys(migration, migration.target.left, migration.target.right, migration.before.left, migration.before.right);
    }

    async _updateAssociationCardinalitiesFromReferenced_N1_to_Single_N1(migration) {
        // We flip the foreign keys and try to migrate data around

        await this._updateAssociationCardinalitiesFlipForeignKeys(migration, migration.target.left, migration.target.right, migration.before.left, migration.before.right);
    }

    async _updateAssociationCardinalitiesFromSingle_N1_to_Referenced_1N(migration) {
        // We flip the foreign keys and try to migrate data around

        await this._updateAssociationCardinalitiesFlipForeignKeys(migration, migration.target.right, migration.target.left, migration.before.left, migration.before.right);
    }

    async _updateAssociationCardinalitiesFromReferenced_1N_to_Single_N1(migration) {
        // We flip the foreign keys and try to migrate data around

        await this._updateAssociationCardinalitiesFlipForeignKeys(migration, migration.target.left, migration.target.right, migration.before.right, migration.before.left);
    }

    async _updateAssociationCardinalitiesFromSingle_N1_to_Referenced_NN(migration) {
        // This requires we create a pivot table and drop the foreign key from the left

        await this._createAssociationRelationship(migration.target.left.list, migration.target.left.field, migration.target.right.list, "id", migration.target.right.field, true);

        const pivotTable = this._getPivotTableName(migration.target.left.list, migration.target.left.field, migration.target.right.list, migration.target.right.field);

        const rows = await this._knex.select().table(migration.before.left.list);

        const columnLeftId  = `${migration.target.left.list}_left_id`;
        const columnRightId = `${migration.target.right.list}_right_id`;
        const columnForeignKey = migration.before.left.field;

        if(migration.target.left.list === migration.before.left.list) {
            await this._knex.insert(rows.map(r => ({ [columnLeftId]: r.id, [columnRightId]: r[columnForeignKey] }))).into(pivotTable);
        } else {
            await this._knex.insert(rows.map(r => ({ [columnRightId]: r.id, [columnLeftId]: r[columnForeignKey] }))).into(pivotTable);
        }

        await this._removeAssociationRelationship(migration.before.left.list, migration.before.left.field, migration.before.right.list);
    }

    async _updateAssociationCardinalitiesFromReferenced_NN_to_Single_N1(migration) {

        await this._createAssociationRelationship(migration.target.left.list, migration.target.left.field, migration.target.right.list);

        const pivotTable = this._getPivotTableName(migration.before.left.list, migration.before.left.field, migration.before.right.list, migration.before.right.field);

        const columnLeftId  = `${migration.before.left.list}_left_id`;
        const columnRightId = `${migration.before.right.list}_right_id`;

        const rows = await this._knex.select().table(pivotTable);

        for(let i=0; i < rows.length; ++i) {

            const r = rows[i];

            if(migration.target.left.list === migration.before.left.list) {

                if(typeof r[columnLeftId] !== "undefined" && r[columnLeftId] !== null) {

                    await this._knex(migration.target.left.list)
                        .where({ id: r[columnLeftId] })
                        .update({ [migration.target.left.field]: r[columnRightId] });
                }
            } else {

                if(typeof r[columnRightId] !== "undefined" && r[columnRightId] !== null) {

                    await this._knex(migration.target.left.list)
                        .where({ id: r[columnRightId] })
                        .update({ [migration.target.left.field]: r[columnLeftId] });

                }
            }
        }

        await this._removeAssociationRelationship(migration.before.left.list, migration.before.left.field, migration.before.right.list, migration.before.right.field, true);


    }

    async _updateAssociationCardinalitiesFromSingle_NN_to_Referenced_NN(migration) {

        // If we rename the table and the columns where appropriate we dont need to
        // be migrating data around

        const beforeTable = this._getPivotTableName(migration.before.left.list, migration.before.left.field, migration.before.right.list);
        const targetTable = this._getPivotTableName(migration.target.left.list, migration.target.left.field, migration.target.right.list, migration.target.right.field);

        await this._knex.schema.renameTable(beforeTable, targetTable);

        // Otherwise the column names are the same
        if(migration.before.left.list !== migration.target.left.list) {

            // Flip left to right

            const beforeLeftColumn  = `${migration.before.left.list}_left_id`;
            const beforeRightColumn = `${migration.before.right.list}_right_id`;

            const targetLeftColumn  = `${migration.before.left.list}_right_id`;
            const targetRightColumn = `${migration.before.right.list}_left_id`;

            await this._knex.schema.table(targetTable, (t) => {
                t.renameColumn(beforeLeftColumn, targetLeftColumn);
                t.renameColumn(beforeRightColumn, targetRightColumn);
            });
        }


    }

    async _updateAssociationCardinalitiesFromReferenced_NN_to_Single_NN(migration) {

        // This is the other way around from _updateAssociationCardinalitiesFromSingle_NN_to_Referenced_NN

        const beforeTable = this._getPivotTableName(migration.before.left.list, migration.before.left.field, migration.before.right.list, migration.before.right.field);
        const targetTable = this._getPivotTableName(migration.target.left.list, migration.target.left.field, migration.target.right.list);

        await this._knex.schema.renameTable(beforeTable, targetTable);

        if(migration.before.left.list !== migration.target.left.list) {

            const beforeLeftColumn  = `${migration.before.left.list}_left_id`;
            const beforeRightColumn = `${migration.before.right.list}_right_id`;

            const targetLeftColumn  = `${migration.before.left.list}_right_id`;
            const targetRightColumn = `${migration.before.right.list}_left_id`;

            await this._knex.schema.table(targetTable, (t) => {
                t.renameColumn(beforeLeftColumn, targetLeftColumn);
                t.renameColumn(beforeRightColumn, targetRightColumn);
            });
        }
    }

    async _updateAssociationCardinalitiesFromReferenced_11_to_Referenced_1N(migration) {
        // We just need to flip the foreign key and migrate that data

        await this._updateAssociationCardinalitiesFlipForeignKeys(migration, migration.target.right, migration.target.left, migration.before.left, migration.before.right);
    }

    async _updateAssociationCardinalitiesFromReferenced_1N_to_Referenced_11(migration) {
        // We just need to flip the foreign key and migrate that data

        await this._updateAssociationCardinalitiesFlipForeignKeys(migration, migration.target.left, migration.target.right, migration.before.right, migration.before.left);
    }

    async _updateAssociationCardinalitiesFromReferenced_11_to_Referenced_N1(migration) {
        // NOOP the keys here wont flip
    }

    async _updateAssociationCardinalitiesFromReferenced_N1_to_Referenced_11(migration) {
        // NOOP
    }

    async _updateAssociationCardinalitiesFromReferenced_11_to_Referenced_NN(migration) {
        // This will create a pivot table copy data and remove the foreign key column

        await this._createAssociationRelationship(migration.target.left.list, migration.target.left.field, migration.target.right.list, "id", migration.target.right.field, true);

        const pivotTable = this._getPivotTableName(migration.target.left.list, migration.target.left.field, migration.target.right.list, migration.target.right.field);

        const rows = await this._knex.select().table(migration.before.left.list);

        const columnLeftId  = `${migration.target.left.list}_left_id`;
        const columnRightId = `${migration.target.right.list}_right_id`;
        const columnForeignKey = migration.before.left.field;

        await this._knex.insert(rows.map(r => ({ [columnLeftId]: r.id, [columnRightId]: r[columnForeignKey] }))).into(pivotTable);

        await this._removeAssociationRelationship(migration.before.left.list, migration.before.left.field, migration.before.right.list);
    }

    async _updateAssociationCardinalitiesFromReferenced_NN_to_Referenced_11(migration) {

        await this._createAssociationRelationship(migration.target.left.list, migration.target.left.field, migration.target.right.list);

        const pivotTable = this._getPivotTableName(migration.before.left.list, migration.before.left.field, migration.before.right.list, migration.before.right.field);

        const columnLeftId  = `${migration.before.left.list}_left_id`;
        const columnRightId = `${migration.before.right.list}_right_id`;

        const rows = await this._knex.select().table(pivotTable);

        for(let i=0; i < rows.length; ++i) {

            const r = rows[i];

            if(typeof r[columnLeftId] !== "undefined" && r[columnLeftId] !== null) {

                await this._knex(migration.target.left.list)
                    .where({ id: r[columnLeftId] })
                    .update({ [migration.target.left.field]: r[columnRightId] });
            }
        }

        await this._removeAssociationRelationship(migration.before.left.list, migration.before.left.field, migration.before.right.list, migration.before.right.field, true);


    }

    async _updateAssociationCardinalitiesFromReferenced_1N_to_Referenced_N1(migration) {
        // Flip the foreign keys
        await this._updateAssociationCardinalitiesFlipForeignKeys(migration, migration.target.left, migration.target.right, migration.before.right, migration.before.left);
    }

    async _updateAssociationCardinalitiesFromReferenced_N1_to_Referenced_1N(migration) {
        // Flip the foreign keys
        await this._updateAssociationCardinalitiesFlipForeignKeys(migration, migration.target.right, migration.target.left, migration.before.left, migration.before.right);
    }

    async _updateAssociationCardinalitiesFromReferenced_1N_to_Referenced_NN(migration) {
        // This will create a pivot table copy data and remove the foreign key column

        await this._createAssociationRelationship(migration.target.left.list, migration.target.left.field, migration.target.right.list, "id", migration.target.right.field, true);

        const pivotTable = this._getPivotTableName(migration.target.left.list, migration.target.left.field, migration.target.right.list, migration.target.right.field);

        const rows = await this._knex.select().table(migration.before.right.list);

        const columnLeftId  = `${migration.target.left.list}_left_id`;
        const columnRightId = `${migration.target.right.list}_right_id`;
        const columnForeignKey = migration.before.right.field;

        await this._knex.insert(rows.map(r => ({ [columnRightId]: r.id, [columnLeftId]: r[columnForeignKey] }))).into(pivotTable);

        await this._removeAssociationRelationship(migration.before.right.list, migration.before.right.field, migration.before.left.list);
    }

    async _updateAssociationCardinalitiesFromReferenced_NN_to_Referenced_1N(migration) {
        await this._createAssociationRelationship(migration.target.right.list, migration.target.right.field, migration.target.left.list);

        const pivotTable = this._getPivotTableName(migration.before.left.list, migration.before.left.field, migration.before.right.list, migration.before.right.field);

        const columnLeftId  = `${migration.before.left.list}_left_id`;
        const columnRightId = `${migration.before.right.list}_right_id`;

        const rows = await this._knex.select().table(pivotTable);

        for(let i=0; i < rows.length; ++i) {

            const r = rows[i];

            if(typeof r[columnLeftId] !== "undefined" && r[columnLeftId] !== null) {

                await this._knex(migration.target.right.list)
                    .where({ id: r[columnRightId] })
                    .update({ [migration.target.right.field]: r[columnLeftId] });
            }
        }

        await this._removeAssociationRelationship(migration.before.left.list, migration.before.left.field, migration.before.right.list, migration.before.right.field, true);


    }

    async _updateAssociationCardinalitiesFromReferenced_N1_to_Referenced_NN(migration) {
        await this._createAssociationRelationship(migration.target.left.list, migration.target.left.field, migration.target.right.list, "id", migration.target.right.field, true);

        const pivotTable = this._getPivotTableName(migration.target.left.list, migration.target.left.field, migration.target.right.list, migration.target.right.field);

        const rows = await this._knex.select().table(migration.before.left.list);

        const columnLeftId  = `${migration.target.left.list}_left_id`;
        const columnRightId = `${migration.target.right.list}_right_id`;
        const columnForeignKey = migration.before.left.field;

        await this._knex.insert(rows.map(r => ({ [columnLeftId]: r.id, [columnRightId]: r[columnForeignKey] }))).into(pivotTable);

        await this._removeAssociationRelationship(migration.before.left.list, migration.before.left.field, migration.before.right.list);
    }

    async _updateAssociationCardinalitiesFromReferenced_NN_to_Referenced_N1(migration) {
        await this._createAssociationRelationship(migration.target.left.list, migration.target.left.field, migration.target.right.list);

        const pivotTable = this._getPivotTableName(migration.before.left.list, migration.before.left.field, migration.before.right.list, migration.before.right.field);

        const columnLeftId  = `${migration.before.left.list}_left_id`;
        const columnRightId = `${migration.before.right.list}_right_id`;

        const rows = await this._knex.select().table(pivotTable);

        for(let i=0; i < rows.length; ++i) {

            const r = rows[i];

            if(typeof r[columnLeftId] !== "undefined" && r[columnLeftId] !== null) {

                await this._knex(migration.target.left.list)
                    .where({ id: r[columnLeftId] })
                    .update({ [migration.target.left.field]: r[columnRightId] });
            }
        }

        await this._removeAssociationRelationship(migration.before.left.list, migration.before.left.field, migration.before.right.list, migration.before.right.field, true);


    }

    async _updateAssociationCardinalities(migration) {

        /* This will be a one by one scenario. There are 20 combination on cardinality changes and while
           some wont require actual changes to the schema, in others we might change columns to pivot tables and try
           to copy data around.

           There is also the risk of truncating data in scenarios like N:N => N:1  and N:1 => 1:1

           So every case is a special case and we're handling this in separate
        */


        // For Single N:1
        if(!migration.before.reference.field && migration.before.cardinality === "N:1") {
            if(!migration.target.reference.field && migration.target.cardinality === "N:N") {
                await this._updateAssociationCardinalitiesFromSingle_N1_to_NN(migration);
            }

            if(migration.target.reference.field && migration.target.cardinality === "1:1") {
                await this._updateAssociationCardinalitiesFromSingle_N1_to_Referenced_11(migration);
            }

            if(migration.target.reference.field && migration.target.cardinality === "1:N") {
                await this._updateAssociationCardinalitiesFromSingle_N1_to_Referenced_1N(migration);
            }

            if(migration.target.reference.field && migration.target.cardinality === "N:1") {
                await this._updateAssociationCardinalitiesFromSingle_N1_to_Referenced_N1(migration);
            }

            if(migration.target.reference.field && migration.target.cardinality === "N:N") {
                await this._updateAssociationCardinalitiesFromSingle_N1_to_Referenced_NN(migration);
            }
        }

        // For Single N:N
        if(!migration.before.reference.field && migration.before.cardinality === "N:N") {
            if(!migration.target.reference.field && migration.target.cardinality === "N:1") {
                await this._updateAssociationCardinalitiesFromSingle_NN_to_N1(migration);
            }

            if(migration.target.reference.field && migration.target.cardinality === "1:1") {
                await this._updateAssociationCardinalitiesFromSingle_NN_to_Referenced_11(migration);
            }

            if(migration.target.reference.field && migration.target.cardinality === "1:N") {
                await this._updateAssociationCardinalitiesFromSingle_NN_to_Referenced_1N(migration);
            }

            if(migration.target.reference.field && migration.target.cardinality === "N:1") {
                await this._updateAssociationCardinalitiesFromSingle_NN_to_Referenced_N1(migration);
            }

            if(migration.target.reference.field && migration.target.cardinality === "N:N") {
                await this._updateAssociationCardinalitiesFromSingle_NN_to_Referenced_NN(migration);
            }
        }

        // For Referenced 1:1
        if(migration.before.reference.field && migration.before.cardinality === "1:1") {
            if(!migration.target.reference.field && migration.target.cardinality === "N:1") {
                await this._updateAssociationCardinalitiesFromReferenced_11_to_Single_N1(migration);
            }

            if(!migration.target.reference.field && migration.target.cardinality === "N:N") {
                await this._updateAssociationCardinalitiesFromReferenced_11_to_Single_NN(migration);
            }

            if(migration.target.reference.field && migration.target.cardinality === "1:N") {
                await this._updateAssociationCardinalitiesFromReferenced_11_to_Referenced_1N(migration);
            }

            if(migration.target.reference.field && migration.target.cardinality === "N:1") {
                await this._updateAssociationCardinalitiesFromReferenced_11_to_Referenced_N1(migration);
            }

            if(migration.target.reference.field && migration.target.cardinality === "N:N") {
                await this._updateAssociationCardinalitiesFromReferenced_11_to_Referenced_NN(migration);
            }
        }

        // For Referenced 1:N
        if(migration.before.reference.field && migration.before.cardinality === "1:N") {
            if(!migration.target.reference.field && migration.target.cardinality === "N:1") {
                await this._updateAssociationCardinalitiesFromReferenced_1N_to_Single_N1(migration);
            }

            if(!migration.target.reference.field && migration.target.cardinality === "N:N") {
                await this._updateAssociationCardinalitiesFromReferenced_1N_to_Single_NN(migration);
            }

            if(migration.target.reference.field && migration.target.cardinality === "1:1") {
                await this._updateAssociationCardinalitiesFromReferenced_1N_to_Referenced_11(migration);
            }

            if(migration.target.reference.field && migration.target.cardinality === "N:1") {
                await this._updateAssociationCardinalitiesFromReferenced_1N_to_Referenced_N1(migration);
            }

            if(migration.target.reference.field && migration.target.cardinality === "N:N") {
                await this._updateAssociationCardinalitiesFromReferenced_1N_to_Referenced_NN(migration);
            }
        }

        // For Referenced N:1
        if(migration.before.reference.field && migration.before.cardinality === "N:1") {
            if(!migration.target.reference.field && migration.target.cardinality === "N:1") {
                await this._updateAssociationCardinalitiesFromReferenced_N1_to_Single_N1(migration);
            }

            if(!migration.target.reference.field && migration.target.cardinality === "N:N") {
                await this._updateAssociationCardinalitiesFromReferenced_N1_to_Single_NN(migration);
            }

            if(migration.target.reference.field && migration.target.cardinality === "1:1") {
                await this._updateAssociationCardinalitiesFromReferenced_N1_to_Referenced_11(migration);
            }

            if(migration.target.reference.field && migration.target.cardinality === "1:N") {
                await this._updateAssociationCardinalitiesFromReferenced_N1_to_Referenced_1N(migration);
            }

            if(migration.target.reference.field && migration.target.cardinality === "N:N") {
                await this._updateAssociationCardinalitiesFromReferenced_N1_to_Referenced_NN(migration);
            }
        }

        // For Referenced N:N
        if(migration.before.reference.field && migration.before.cardinality === "N:N") {
            if(!migration.target.reference.field && migration.target.cardinality === "N:1") {
                await this._updateAssociationCardinalitiesFromReferenced_NN_to_Single_N1(migration);
            }

            if(!migration.target.reference.field && migration.target.cardinality === "N:N") {
                await this._updateAssociationCardinalitiesFromReferenced_NN_to_Single_NN(migration);
            }

            if(migration.target.reference.field && migration.target.cardinality === "1:1") {
                await this._updateAssociationCardinalitiesFromReferenced_NN_to_Referenced_11(migration);
            }

            if(migration.target.reference.field && migration.target.cardinality === "1:N") {
                await this._updateAssociationCardinalitiesFromReferenced_NN_to_Referenced_1N(migration);
            }

            if(migration.target.reference.field && migration.target.cardinality === "N:1") {
                await this._updateAssociationCardinalitiesFromReferenced_NN_to_Referenced_N1(migration);
            }
        }
    }

    async _updateAssociation(migration) {

        if(migration.target.type === "Relationship" && migration.before.type === "Relationship") {
            // Watchout for a cardinality update
            await this._updateAssociationCardinalities(migration);
        } else {
            // We are turning scalar types to relationships or vice versa

            if(migration.target.type === "Relationship") {
                await this._updateAssociationFieldToRelationship(migration);
            } else {
                await this._updateAssociationRelationshipToField(migration);
            }
        }
    }

    async _fetchAssociationDataForField(list, field) {
        return await this._knex.select([`${list}.id`, `${list}.${field.name} as columnValue`]).from(list);
    }

    /*
    _insertRelationshipDataFromColumnRows(list, relationshipField, field, data) {

    }
    */
    
    // Here
    async _updateAssociationFieldToRelationship(migration) {

        const data = await this._fetchAssociationDataForField(migration.name, migration.before);

        await this._removeField({ list: migration.name, field: migration.before });
        await this._createAssociation(migration.target);        

        // TODO:
        //await this._insertRelationshipDataFromColumnRows(migration.name, migration.target, migration.before, data);
    }
    

    async _fetchAssociationDataForRelationship(field) {

        if(!field.reference.field && field.cardinality === 'N:1') {
            return await this._knex.select([`${field.right.list}.*`, `${field.left.list}.id as _id`]).from(field.right.list).innerJoin(field.left.list, `${field.left.list}.${field.left.field}`, `${field.right.list}.id`);
        }

        if(!field.reference.field && field.cardinality === 'N:N') {

            const pivotTable = this._getPivotTableName(field.left.list, field.left.field, field.right.list, field.right.field);

            const pivotTableLeftColumn  = `${field.left.list}_left_id`;
            const pivotTableRightColumn = `${field.right.list}_right_id`;

            return await this._knex.select([`${field.right.list}.*`, `${field.left.list}.id as _id`])
                .from(field.right.list)
                .innerJoin(pivotTable, `${pivotTable}.${pivotTableRightColumn}`, `${field.right.list}.id`)
                .innerJoin(field.left.list, `${pivotTable}.${pivotTableLeftColumn}`, `${field.left.list}.id`);
        }


        if(field.reference.list === field.left.list && field.reference.field === field.left.field) {

            if(field.reference.field && (field.cardinality === '1:1' || field.cardinality === 'N:1')) {
                return await this._knex.select([`${field.left.list}.*`, `${field.right.list}.id as _id`]).from(field.left.list).innerJoin(field.right.list, `${field.left.list}.${field.left.field}`, `${field.right.list}.id`);
            }

            if(field.reference.field && field.cardinality === '1:N') {
                return await this._knex.select([`${field.left.list}.*`, `${field.right.list}.id as _id`]).from(field.left.list).innerJoin(field.right.list, `${field.right.list}.${field.right.field}`, `${field.left.list}.id`);
            }

            if(field.reference.field && field.cardinality === 'N:N') {

                const pivotTable = this._getPivotTableName(field.left.list, field.left.field, field.right.list, field.right.field);

                const pivotTableLeftColumn  = `${field.left.list}_left_id`;
                const pivotTableRightColumn = `${field.right.list}_right_id`;

                return await this._knex.select([`${field.left.list}.*`, `${field.right.list}.id as _id`])
                    .from(field.left.list)
                    .innerJoin(pivotTable, `${pivotTable}.${pivotTableLeftColumn}`, `${field.left.list}.id`)
                    .innerJoin(field.right.list, `${pivotTable}.${pivotTableRightColumn}`, `${field.right.list}.id`);
            }
        } else {

            if(field.reference.field && (field.cardinality === '1:1' || field.cardinality === 'N:1')) {
                return await this._knex.select([`${field.right.list}.*`, `${field.left.list}.id as _id`]).from(field.right.list).innerJoin(field.left.list, `${field.left.list}.${field.left.field}`, `${field.right.list}.id`);
            }

            if(field.reference.field && field.cardinality === '1:N') {
                return await this._knex.select([`${field.right.list}.*`, `${field.left.list}.id as _id`]).from(field.right.list).innerJoin(field.left.list, `${field.right.list}.${field.right.field}`, `${field.left.list}.id`);
            }

            if(field.reference.field && field.cardinality === 'N:N') {

                const pivotTable = this._getPivotTableName(field.left.list, field.left.field, field.right.list, field.right.field);

                const pivotTableLeftColumn  = `${field.left.list}_left_id`;
                const pivotTableRightColumn = `${field.right.list}_right_id`;

                return await this._knex.select([`${field.right.list}.*`, `${field.left.list}.id as _id`])
                    .from(field.right.list)
                    .innerJoin(pivotTable, `${pivotTable}.${pivotTableRightColumn}`, `${field.right.list}.id`)
                    .innerJoin(field.left.list, `${pivotTable}.${pivotTableLeftColumn}`, `${field.left.list}.id`);
            }            
            
        }

        throw Error("Cardinality not implemented in relationship field");
    }

    _getDataColumnNameAccordingToFieldType(field, row) {
        // I have to say that this is far from perfect since we try to infer the right
        // column value based on a target field native type without knowing the field types for the row values
        // However we think most scenarios will have varchar string values from relationship--but
        // this is only common sense based on our personal experience

        let typeofValue;

        switch(field.type) {
        case 'Checkbox':
            typeofValue = 'boolean';
            break;

        case 'Decimal':
        case 'Float':
        case 'Integer':
            typeofValue = 'number';
            break;
        default:
            typeofValue = 'string';
        }

        return Object.keys(row).find(key => key !== 'id' && typeof row[key] === typeofValue);
    }

    async _insertColumnDataFromRelationshipRows(list, field, relationshipField, data) {
        for(let i = 0; i < data.length; ++i) {
            const row = data[i];

            const columnName = this._getDataColumnNameAccordingToFieldType(field, row);

            if(columnName) {
                await this._knex(list).where({ id: row['_id']}).update({ [field.name]: row[columnName] });
            }
        }
    }

    async _updateAssociationRelationshipToField(migration) {

        // Our best scenario here is we can migrate some data from this association by querying the associated
        // values (will be rows from referenced table) and finding the first column that match our association
        // field data type

        const data = await this._fetchAssociationDataForRelationship(migration.before);

        await this._removeAssociation(migration.before);
        await this._createField( { list: migration.name, field: migration.target });

        await this._insertColumnDataFromRelationshipRows(migration.name, migration.target, migration.before, data);
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

    async _renameAssociation(migration) {

        if(!migration.target.reference.field) {

            if(migration.cardinality === "N:1") {
                await this._renameAssociationRelationship(migration.target.left.list, migration.target.left.field, migration.target.right.list, migration.before.name);
            }

            if(migration.cardinality === "N:N") {
                await this._renameAssociationRelationship(migration.target.left.list, migration.target.left.field, migration.target.right.list, migration.before.name, undefined, true);
            }

        } else {

            if(migration.cardinality === "1:1" || migration.cardinality === "N:1") {

                if(migration.name !== migration.target.left.list || migration.field === migration.before.name) {

                    // We don't have a real change in foreign keys in this scenario
                    return;
                }

                await this._renameAssociationRelationship(migration.target.left.list, migration.target.left.field, migration.target.right.list, migration.before.name);
            }

            if(migration.cardinality === "1:N") {

                if(migration.name !== migration.target.right.list || migration.field === migration.before.name) {

                    // We don't have a real change in foreign keys in this scenario
                    return;
                }

                await this._renameAssociationRelationship(migration.target.right.list, migration.target.right.field, migration.target.left.list, migration.before.name);

            }

            if(migration.cardinality === "N:N") {
                await this._renameAssociationRelationship(migration.target.left.list, migration.target.left.field, migration.target.right.list, migration.before.left.field, migration.target.right.field, true, migration.before.right.field);
            }
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

    async _removeAssociation(migration) {

        if(!migration.reference.field) {

            if(migration.cardinality === "N:1") {
                await this._removeAssociationRelationship(migration.left.list, migration.left.field, migration.reference.list);
            }

            if(migration.cardinality === "N:N") {
                await this._removeAssociationRelationship(migration.left.list, migration.left.field, migration.reference.list, migration.reference.field, true);
            }

        } else {

            if(migration.cardinality === "1:1" || migration.cardinality === "N:1") {
                await this._removeAssociationRelationship(migration.left.list, migration.left.field, migration.right.list);
            }

            if(migration.cardinality === "1:N") {
                await this._removeAssociationRelationship(migration.right.list, migration.right.field, migration.right.list);
            }

            if(migration.cardinality === "N:N") {
                await this._removeAssociationRelationship(migration.left.list, migration.left.field, migration.right.list, migration.right.field, true);
            }
        }
    }

    async _dropTable(migration) {

        const tableName = migration.options.tableName || migration.name;

        await this._knex.schema.dropTableIfExists(tableName);
    }

    _listAdapterFieldAddToTableSchema(field, table, isAlter = false) {

        const callstack = field.options.knexOptions.config;

        callstack.forEach(alterFieldCall => {
            let t = table[alterFieldCall.method](... alterFieldCall.args);

            alterFieldCall.chainables.forEach(chainable => {
                t = t[chainable.name](... chainable.args);
            });

            if(true === isAlter) {
                t = t.alter();
            }
        });
    }
}

module.exports = MigrationExecution;
