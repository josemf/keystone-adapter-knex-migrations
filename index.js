const { KnexAdapter, KnexListAdapter, KnexFieldAdapter } = require('@keystonejs/adapter-knex');

const MigrationBuilder   = require('./lib/migration_builder');
const MigrationExecution = require('./lib/migration_execution');

const fs = require('fs');

const {
    escapeRegExp,
    pick,
} = require('@keystonejs/utils');

const MIGRATIONS_FILE_PATH = './compiled/migrations.json';
const MIGRATIONS_SCHEMA_FILE_PATH = './compiled/schema.json';
const DEFAULT_CACHE_SCHEMA_TABLE_NAME = "InternalSchema";

class KnexAdapterExtended extends KnexAdapter {

    constructor({ knexOptions = {}, knexMigrationsOptions = {}, schemaName = 'public' } = {}) {

        super(...arguments);

        if(this.isNotPostgres()) {
            this.schemaName = 'mysql';
        }

        this.listAdapterClass = MysqlCompatibleKnexListAdapter;

        KnexAdapterExtended.defaultListAdapterClass = MysqlCompatibleKnexListAdapter;

        this._knexMigrationsOptions = Object.assign({}, {
            migrationsFilePath: MIGRATIONS_FILE_PATH,
            migrationsSchemaFilePath: MIGRATIONS_SCHEMA_FILE_PATH,
            schemaTableName: DEFAULT_CACHE_SCHEMA_TABLE_NAME
        }, knexMigrationsOptions);
    }

    isNotPostgres() {
        return this.client !== 'postgres';
    }

    async checkDatabaseVersion() {
        return false;
    }

    dropDatabase() {

        if(!this.isNotPostgres()) {
            return super.dropDatabase();
        }
        
        if (process.env.NODE_ENV !== 'test') {
            console.log('Knex adapter: Dropping database');
        }
        const tables = [
            ...Object.values(this.listAdapters).map(
                listAdapter => `\`${this.schemaName}\`.\`${listAdapter.tableName}\``
            ),
            ...this.rels
                .filter(({ cardinality }) => cardinality === 'N:N')
                .map(({ tableName }) => `\`${this.schemaName}\`.\`${tableName}\``),
        ].join(',');

        return this.knex.raw(`SET FOREIGN_KEY_CHECKS=0`).then(() => this.knex.raw(`DROP TABLE IF EXISTS ${tables} CASCADE`));
    }

    async createMigrations(spinner) {

        const builder = new MigrationBuilder(this.listAdapters, this.knex, {
            cacheSchemaTableName: DEFAULT_CACHE_SCHEMA_TABLE_NAME,
            spinner
        });

        const { migrations, schema } = await builder.build();

        fs.writeFileSync(this._knexMigrationsOptions.migrationsFilePath, JSON.stringify(migrations));
        fs.writeFileSync(this._knexMigrationsOptions.migrationsSchemaFilePath, JSON.stringify({ schema }));
    }

    async rollbackMigrations(spinner) {
        const builder = new MigrationBuilder(this.listAdapters, this.knex, {
            cacheSchemaTableName: DEFAULT_CACHE_SCHEMA_TABLE_NAME,
            spinner
        });

        const { migrations, schema, id } = await builder.buildRollback();

        fs.writeFileSync(this._knexMigrationsOptions.migrationsFilePath, JSON.stringify(migrations));
        fs.writeFileSync(this._knexMigrationsOptions.migrationsSchemaFilePath, JSON.stringify({ schema, cmd: "rollback", id }));
    }

    async forwardMigrations(spinner) {
        const builder = new MigrationBuilder(this.listAdapters, this.knex, {
            cacheSchemaTableName: DEFAULT_CACHE_SCHEMA_TABLE_NAME,
            spinner
        });

        const { migrations, schema, id } = await builder.buildForward();

        fs.writeFileSync(this._knexMigrationsOptions.migrationsFilePath, JSON.stringify(migrations));
        fs.writeFileSync(this._knexMigrationsOptions.migrationsSchemaFilePath, JSON.stringify({ schema, cmd: "forward", id }));
    }

    async doMigrations(spinner) {

        if(!fs.existsSync(this._knexMigrationsOptions.migrationsFilePath)) {
            console.log(`Needs migrations file in place ${MIGRATIONS_FILE_PATH}`);
            return;
        }

        if(!fs.existsSync(this._knexMigrationsOptions.migrationsSchemaFilePath)) {
            console.log(`Needs migrations schema file in place ${MIGRATIONS_SCHEMA_FILE_PATH}`);
            return;
        }

        const migrations = JSON.parse(fs.readFileSync(this._knexMigrationsOptions.migrationsFilePath, "utf-8"));
        const schema = JSON.parse(fs.readFileSync(this._knexMigrationsOptions.migrationsSchemaFilePath, "utf-8"));

        const execution = new MigrationExecution(this.listAdapters, this.knex, {
            cacheSchemaTableName: this._knexMigrationsOptions.schemaTableName,
            spinner
        });

        await execution.apply(migrations, JSON.stringify(schema.schema), schema.cmd, schema.id);
    }
}

// Lets try to our best to have some decent mysql support--because there might be reasons not
// to user postgres and we're stuck

class MysqlCompatibleKnexListAdapter extends KnexListAdapter {
    constructor(key, parentAdapter) {
        super(...arguments);
    }

    newFieldAdapter(fieldAdapterClass, name, path, field, getListByKey, config) {
        
        if(!this.parentAdapter.isNotPostgres()) {
            return super.newFieldAdapter(... arguments);
        }

        const mysqlCompatibleFieldAdapterInstance = new MysqlCompatibleKnexFieldAdapter(... arguments);

        const fieldAdapterInstance = super.newFieldAdapter(... arguments);

        // Monkey patching....

        ['stringConditionsInsensitive', 'stringConditions', 'equalityConditionsInsensitive'].forEach(methodName => {
            fieldAdapterInstance[methodName] = mysqlCompatibleFieldAdapterInstance[methodName];
        });

        return fieldAdapterInstance;
    }
    
    async _itemsQuery(args, { meta = false, from = {} } = {}) {

        /*
          if(!this.parentAdapter.isNotPostgres()) {
          return super._itemsQuery(... arguments);
          }
        */
        const query = new MysqlCompatibleQueryBuilder(this, args, { meta, from }).get();

        const results = await query;

        if (meta) {
            const { first, skip } = args;
            const ret = results[0];
            let count = ret.count;

            // Adjust the count as appropriate
            if (skip !== undefined) {
                count -= skip;
            }
            if (first !== undefined) {
                count = Math.min(count, first);
            }
            count = Math.max(0, count); // Don't want to go negative from a skip!
            return { count };
        }

        return results;
    }

    // returning as no effect, have to fetch the row
    async _createSingle(realData) {

        if(!this.parentAdapter.isNotPostgres()) {
            return super._createSingle(... arguments);
        }
        
        const createQuery = this._query().insert(realData).into(this.tableName);
        
        const createdItemId = await createQuery;

        const item = (await this._query().table(this.tableName).where('id', createdItemId))[0];

        return { item, itemId: item.id };
    }

    async _update(id, data) {

        if(!this.parentAdapter.isNotPostgres()) {
            return super._update(... arguments);
        }

        const realData = pick(data, this.realKeys);
        
        // Unset any real 1:1 fields
        await this._unsetOneToOneValues(realData);
        await this._unsetForeignOneToOneValues(data, id);

        // Update the real data
        const query = this._query().table(this.tableName).where({ id });
        if (Object.keys(realData).length) {
            query.update(realData);
        }
        
        await query;
        const item = (await this._query().table(this.tableName).where('id', id))[0];
        
        // For every many-field, update the many-table
        await this._processNonRealFields(data, async ({ path, value: newValues, adapter }) => {
            const { cardinality, columnName, tableName } = adapter.rel;
            let value;
            // Future task: Is there some way to combine the following three
            // operations into a single query?

            if (cardinality !== '1:1') {
                // Work out what we've currently got
                let matchCol, selectCol;
                if (cardinality === 'N:N') {
                    const { near, far } = this._getNearFar(adapter);
                    matchCol = near;
                    selectCol = far;
                } else {
                    matchCol = columnName;
                    selectCol = 'id';
                }
                const currentRefIds = (
                    await this._query()
                        .select(selectCol)
                        .from(tableName)
                        .where(matchCol, item.id)
                ).map(x => x[selectCol].toString());

                // Delete what needs to be deleted
                const needsDelete = currentRefIds.filter(x => !newValues.includes(x));
                if (needsDelete.length) {
                    if (cardinality === 'N:N') {
                        await this._query()
                            .table(tableName)
                            .where(matchCol, item.id) // near side
                            .whereIn(selectCol, needsDelete) // far side
                            .del();
                    } else {
                        await this._query()
                            .table(tableName)
                            .whereIn(selectCol, needsDelete)
                            .update({ [columnName]: null });
                    }
                }
                value = newValues.filter(id => !currentRefIds.includes(id));
            } else {
                // If there are values, update the other side to point to me,
                // otherwise, delete the thing that was pointing to me
                if (newValues === null) {
                    const selectCol = columnName === path ? 'id' : columnName;
                    await this._setNullByValue({ tableName, columnName: selectCol, value: item.id });
                }
                value = newValues;
            }
            await this._createOrUpdateField({ value, adapter, itemId: item.id });
        });
        return (await this._itemsQuery({ where: { id: item.id }, first: 1 }))[0] || null;
    }

    async _createOrUpdateField({ value, adapter, itemId }) {

        if(!this.parentAdapter.isNotPostgres()) {
            return super._createOrUpdateField(... arguments);
        }
        
        const { cardinality, columnName, tableName } = adapter.rel;
        // N:N - put it in the many table
        // 1:N - put it in the FK col of the other table
        // 1:1 - put it in the FK col of the other table

        if (cardinality === '1:1') {
            if (value !== null) {

                // TODO: This goes with a promise

                return this._query()
                    .table(tableName)
                    .where('id', value)
                    .update({ [columnName]: itemId }).then(result => {
                        // In mysql we must explicitly return the set id
                        // Which is `value`. Update returns number of affected rows
                        return value;
                    });
            } else {
                return null;
            }
        } else {

            const values = value; // Rename this because we have a many situation
            if (values.length) {
                if (cardinality === 'N:N') {
                    const { near, far } = this._getNearFar(adapter);
                    return this._query()
                        .insert(values.map(id => ({ [near]: itemId, [far]: id })))
                        .into(tableName)
                    //                        .returning(far);
                } else {

                    return this._query()
                        .table(tableName)
                        .whereIn('id', values) // 1:N
                        .update({ [columnName]: itemId })
                    //                        .returning('id');
                }
            } else {
                return [];
            }
        }
    }
}

// Unfortunately had to copy all code: Changes are marked as MYSQL HERE:

class MysqlCompatibleQueryBuilder {
    constructor(
        listAdapter,
        { where = {}, first, skip, sortBy, orderBy, search },
        { meta = false, from = {} }
    ) {
        this._tableAliases = {};
        this._selectNames =  {};
        this._selectNamesCount = 0;
        
        this._nextBaseTableAliasId = 0;

        const baseTableAlias = this._getNextBaseTableAlias();

        this._query = listAdapter._query().from(`${listAdapter.tableName} as ${baseTableAlias}`);

        if (!meta) {
            // SELECT t0.* from <tableName> as t0
            this._query.column(`${baseTableAlias}.*`);
        }
        
        this._addJoins(this._query, listAdapter, where, baseTableAlias);
        
        // Joins/where to effectively translate us onto a different list
        if (Object.keys(from).length) {

            const a = from.fromList.adapter.fieldAdaptersByPath[from.fromField];
            const { cardinality, tableName, columnName } = a.rel;

            const otherTableAlias = this._getNextBaseTableAlias();

            if (cardinality === 'N:N') {
                const { near, far } = from.fromList.adapter._getNearFar(a);

                this._query.leftOuterJoin(
                    `${tableName} as ${otherTableAlias}`,
                    `${otherTableAlias}.${far}`,
                    `${baseTableAlias}.id`
                );
                this._query.whereRaw('true');
                this._query.andWhere(`${otherTableAlias}.${near}`, `=`, from.fromId);
            } else {
                this._query.leftOuterJoin(
                    `${tableName} as ${otherTableAlias}`,
                    `${baseTableAlias}.${columnName}`,
                    `${otherTableAlias}.id`
                );
                this._query.whereRaw('true');
                this._query.andWhere(`${baseTableAlias}.${columnName}`, `=`, from.fromId);
            }
        } else {
            // Dumb sentinel to avoid juggling where() vs andWhere()
            // PG is smart enough to see it's a no-op, and now we can just keep chaining andWhere()
            this._query.whereRaw('true');
        }

        this._addWheres(w => this._query.andWhere(w), listAdapter, where, baseTableAlias);

        // TODO: Implement configurable search fields for lists
        const searchField = listAdapter.fieldAdaptersByPath['name'];
        if (search !== undefined && searchField) {
            if (searchField.fieldName === 'Text') {

                // MYSQL HERE:
                // Lets say postgres `~* word` mysql equivalent is LIKE "%word%"

                const f = escapeRegExp;
                
                if(listAdapter.parentAdapter.isNotPostgres()) {

                    if(search) {                    
                        this._query.andWhere(`${baseTableAlias}.name`, 'REGEXP', f(search));
                    }
                } else {
                    this._query.andWhere(`${baseTableAlias}.name`, '~*', f(search));
                }

            } else {
                this._query.whereRaw('false'); // Return no results
            }
        }

        // Add query modifiers as required
        if (meta) {
            this._query = listAdapter.parentAdapter.knex
                .count('* as count')
                .from(this._query.as('unused_alias'));
        } else {
            if (first !== undefined) {
                // SELECT ... LIMIT <first>
                this._query.limit(first);
            }
            if (skip !== undefined) {
                // SELECT ... OFFSET <skip>
                this._query.offset(skip);
            }
            if (orderBy !== undefined) {
                // SELECT ... ORDER BY <orderField>
                const [orderField, orderDirection] = this._getOrderFieldAndDirection(orderBy);
                const sortKey = listAdapter.fieldAdaptersByPath[orderField].sortKey || orderField;

                // Changed in MYSQL COMPAT:
                // For tables with relationship fields that dont exist in the table this would result in
                // adding a order by field that doesn't exists, resulting in an error
                if(listAdapter.realKeys.includes(sortKey)) {
                    this._query.orderBy(sortKey, orderDirection);
                }
            }
            if (sortBy !== undefined) {
                // SELECT ... ORDER BY <orderField>[, <orderField>, ...]

                const orderBy = sortBy.map(s => {
                    const [orderField, orderDirection] = this._getOrderFieldAndDirection(s);

                    const sortKey = listAdapter.fieldAdaptersByPath[orderField].sortKey || orderField;

                    if(listAdapter.realKeys.includes(sortKey)) {
                        return { column: sortKey, order: orderDirection };
                    } else {
                        return undefined;
                    }
                }).filter(s => typeof s !== "undefined");

                this._query.orderBy(

                    // Changed in MYSQL COMPAT:
                    // For tables with relationship fields that dont exist in the table this would result in
                    // adding a order by field that doesn't exists, resulting in an error

                    orderBy
                );

            }
        }
    }

    get() {
        return this._query;
    }

    _getOrderFieldAndDirection(str) {
        const splits = str.split('_');
        const orderField = splits.slice(0, splits.length - 1).join('_');
        const orderDirection = splits[splits.length - 1];
        return [orderField, orderDirection];
    }

    _getNextBaseTableAlias() {
        const alias = `t${this._nextBaseTableAliasId++}`;
        this._tableAliases[alias] = true;
        return alias;
    }

    _getQueryConditionByPath(listAdapter, path, tableAlias) {
        let dbPath = path;
        let fieldAdapter = listAdapter.fieldAdaptersByPath[dbPath];

        while (!fieldAdapter && dbPath.includes('_')) {
            dbPath = dbPath.split('_').slice(0, -1).join('_');
            fieldAdapter = listAdapter.fieldAdaptersByPath[dbPath];
        }

        // Can't assume dbPath === fieldAdapter.dbPath (sometimes it isn't)
        return (
            fieldAdapter &&
                fieldAdapter.getQueryConditions(
                    fieldAdapter.isRelationship &&
                        fieldAdapter.rel.cardinality === '1:1' &&
                        fieldAdapter.rel.right === fieldAdapter.field
                        ? `${tableAlias}__${fieldAdapter.path}.id`
                        : `${tableAlias}.${fieldAdapter.dbPath}`
                )[path]
        );
    }

    // Recursively traverse the `where` query to identify required joins and add them to the query
    // We perform joins on non-many relationship fields which are mentioned in the where query.
    // Joins are performed as left outer joins on fromTable.fromCol to toTable.id
    _addJoins(query, listAdapter, where, tableAlias) {
        // Insert joins to handle 1:1 relationships where the FK is stored on the other table.
        // We join against the other table and select its ID as the path name, so that it appears
        // as if it existed on the primary table all along!

        const joinPaths = Object.keys(where).filter(
            path => !this._getQueryConditionByPath(listAdapter, path)
        );
        
        const joinedPaths = [];
        listAdapter.fieldAdapters
            .filter(a => a.isRelationship && a.rel.cardinality === '1:1' && a.rel.right === a.field)
            .forEach(({ path, rel }) => {
                
                const { tableName, columnName } = rel;
                const otherTableAlias = `${tableAlias}__${path}`;
                if (!this._tableAliases[otherTableAlias]) {
                    this._tableAliases[otherTableAlias] = true;
                    // LEFT OUTERJOIN on ... table>.<id> = <otherTable>.<columnName> SELECT <othertable>.<id> as <path>                    
                    query.leftOuterJoin(
                        `${tableName} as ${otherTableAlias}`,
                        `${otherTableAlias}.${columnName}`,
                        `${tableAlias}.id`
                    );

                    if(this._selectNames[path] !== true) {                    
                        query.select(`${otherTableAlias}.id as ${path}`);
                        this._selectNames[path] = true;                        
                    } else {
                        query.select(`${otherTableAlias}.id as ${path}_${++this._selectNamesCount}`);
                    }
                    
                    joinedPaths.push(path);
                }
            });
        
        for (let path of joinPaths) {
            if (path === 'AND' || path === 'OR') {
                // AND/OR we need to traverse their children                
                where[path].forEach(x => this._addJoins(query, listAdapter, x, tableAlias));
            } else {
                                
                const otherAdapter = listAdapter.fieldAdaptersByPath[path];
                // If no adapter is found, it must be a query of the form `foo_some`, `foo_every`, etc.
                // These correspond to many-relationships, which are handled separately
                if (otherAdapter && !joinedPaths.includes(path)) {
                    // We need a join of the form:
                    // ... LEFT OUTER JOIN {otherList} AS t1 ON {tableAlias}.{path} = t1.id
                    // Each table has a unique path to the root table via foreign keys
                    // This is used to give each table join a unique alias
                    // E.g., t0__fk1__fk2
                    const otherList = otherAdapter.refListKey;
                    const otherListAdapter = listAdapter.getListAdapterByKey(otherList);
                    const otherTableAlias = `${tableAlias}__${path}`;
                    if (!this._tableAliases[otherTableAlias]) {
                        this._tableAliases[otherTableAlias] = true;
                        query.leftOuterJoin(
                            `${otherListAdapter.tableName} as ${otherTableAlias}`,
                            `${otherTableAlias}.id`,
                            `${tableAlias}.${path}`
                        );
                    }
                    
                    this._addJoins(query, otherListAdapter, where[path], otherTableAlias);
                }
            }
        }
    }

    // Recursively traverses the `where` query and pushes knex query functions to whereJoiner,
    // which will normally do something like pass it to q.andWhere() to add to a query
    _addWheres(whereJoiner, listAdapter, where, tableAlias) {
        for (let path of Object.keys(where)) {
            const condition = this._getQueryConditionByPath(listAdapter, path, tableAlias);
            if (condition) {
                whereJoiner(condition(where[path]));
            } else if (path === 'AND' || path === 'OR') {
                whereJoiner(q => {
                    // AND/OR need to traverse both side of the query
                    let subJoiner;
                    if (path == 'AND') {
                        q.whereRaw('true');
                        subJoiner = w => q.andWhere(w);
                    } else {
                        q.whereRaw('false');
                        subJoiner = w => q.orWhere(w);
                    }
                    where[path].forEach(subWhere =>
                                        this._addWheres(subJoiner, listAdapter, subWhere, tableAlias)
                                       );
                });
            } else {
                // We have a relationship field
                let fieldAdapter = listAdapter.fieldAdaptersByPath[path];
                if (fieldAdapter) {
                    // Non-many relationship. Traverse the sub-query, using the referenced list as a root.
                    const otherListAdapter = listAdapter.getListAdapterByKey(fieldAdapter.refListKey);
                    this._addWheres(whereJoiner, otherListAdapter, where[path], `${tableAlias}__${path}`);
                } else {
                    // Many relationship
                    const [p, constraintType] = path.split('_');
                    fieldAdapter = listAdapter.fieldAdaptersByPath[p];
                    const { rel } = fieldAdapter;
                    const { cardinality, tableName, columnName } = rel;
                    const subBaseTableAlias = this._getNextBaseTableAlias();
                    const otherList = fieldAdapter.refListKey;
                    const otherListAdapter = listAdapter.getListAdapterByKey(otherList);
                    const subQuery = listAdapter._query();
                    let otherTableAlias;
                    let selectCol;
                    if (cardinality === '1:N' || cardinality === 'N:1') {
                        otherTableAlias = subBaseTableAlias;
                        selectCol = columnName;
                        subQuery
                            .select(`${subBaseTableAlias}.${selectCol}`)
                            .from(`${tableName} as ${subBaseTableAlias}`);
                        // We need to filter out nulls before passing back to the top level query
                        // otherwise postgres will give very incorrect answers.
                        subQuery.whereNotNull(columnName);
                    } else {
                        const { near, far } = listAdapter._getNearFar(fieldAdapter);
                        otherTableAlias = `${subBaseTableAlias}__${p}`;
                        selectCol = near;
                        subQuery
                            .select(`${subBaseTableAlias}.${selectCol}`)
                            .from(`${tableName} as ${subBaseTableAlias}`);
                        subQuery.innerJoin(
                            `${otherListAdapter.tableName} as ${otherTableAlias}`,
                            `${otherTableAlias}.id`,
                            `${subBaseTableAlias}.${far}`
                        );
                    }
                    
                    this._addJoins(subQuery, otherListAdapter, where[path], otherTableAlias);

                    // some: the ID is in the examples found
                    // none: the ID is not in the examples found
                    // every: the ID is not in the counterexamples found
                    // FIXME: This works in a general and logical way, but doesn't always generate the queries that PG can best optimise
                    // 'some' queries would more efficient as inner joins

                    if (constraintType === 'every') {
                        subQuery.whereNot(q => {
                            q.whereRaw('true');
                            this._addWheres(w => q.andWhere(w), otherListAdapter, where[path], otherTableAlias);
                        });
                    } else {
                        subQuery.whereRaw('true');
                        this._addWheres(
                            w => subQuery.andWhere(w),
                            otherListAdapter,
                            where[path],
                            otherTableAlias
                        );
                    }

                    // Ensure there therwhereIn/whereNotIn query is run against
                    // a table with exactly one column.
                    const subSubQuery = listAdapter.parentAdapter.knex
                          .select(selectCol)
                          .from(subQuery.as('unused_alias'));
                    if (constraintType === 'some') {
                        whereJoiner(q => q.whereIn(`${tableAlias}.id`, subSubQuery));
                    } else {
                        whereJoiner(q => q.whereNotIn(`${tableAlias}.id`, subSubQuery));
                    }
                }
            }
        }
    }
}

class MysqlCompatibleKnexFieldAdapter extends KnexFieldAdapter {
    constructor() {
        super(...arguments);
    }

    equalityConditionsInsensitive(dbPath) {
        const f = escapeRegExp;
        return {
            [`${this.path}_i`]: value => b => b.where(dbPath, 'REGEXP', `^${f(value)}$`),
            [`${this.path}_not_i`]: value => b =>
                b.where(dbPath, 'NOT REGEXP', `^${f(value)}$`).orWhereNull(dbPath),
        };
    }

/*
    
    stringConditions(dbPath) {
        const f = escapeRegExp;
        return {
            [`${this.path}_contains`]: value => b => b.where(dbPath, 'REGEXP BINARY', f(value)),
            [`${this.path}_not_contains`]: value => b =>
                b.where(dbPath, 'NOT REGEXP BINARY', f(value)).orWhereNull(dbPath),
            [`${this.path}_starts_with`]: value => b => b.where(dbPath, 'REGEXP BINARY', `^${f(value)}`),
            [`${this.path}_not_starts_with`]: value => b =>
                b.where(dbPath, 'NOT REGEXP BINARY', `^${f(value)}`).orWhereNull(dbPath),
            [`${this.path}_ends_with`]: value => b => b.where(dbPath, 'REGEXP BINARY', `${f(value)}$`),
            [`${this.path}_not_ends_with`]: value => b =>
                b.where(dbPath, 'NOT REGEXP BINARY', `${f(value)}$`).orWhereNull(dbPath),
        };
    }

*/

    stringConditions(dbPath) {
        const f = escapeRegExp;
        
        return {
            [`${this.path}_contains`]: value => b => b.where(dbPath, 'REGEXP', f(value)),
            [`${this.path}_not_contains`]: value => b =>
                b.where(dbPath, 'NOT REGEXP', f(value)).orWhereNull(dbPath),
            [`${this.path}_starts_with`]: value => b => b.where(dbPath, 'REGEXP', `^${f(value)}`),
            [`${this.path}_not_starts_with`]: value => b =>
                b.where(dbPath, 'NOT REGEXP', `^${f(value)}`).orWhereNull(dbPath),
            [`${this.path}_ends_with`]: value => b => b.where(dbPath, 'REGEXP', `${f(value)}$`),
            [`${this.path}_not_ends_with`]: value => b =>
                b.where(dbPath, 'NOT REGEXP', `${f(value)}$`).orWhereNull(dbPath),
        };
    }    

    stringConditionsInsensitive(dbPath) {
        const f = escapeRegExp;
        return {
            [`${this.path}_contains_i`]: value => b => b.where(dbPath, 'REGEXP', f(value)),
            [`${this.path}_not_contains_i`]: value => b =>
                b.where(dbPath, 'NOT REGEXP', f(value)).orWhereNull(dbPath),
            [`${this.path}_starts_with_i`]: value => b => b.where(dbPath, 'REGEXP', `^${f(value)}`),
            [`${this.path}_not_starts_with_i`]: value => b =>
                b.where(dbPath, 'NOT REGEXP', `^${f(value)}`).orWhereNull(dbPath),
            [`${this.path}_ends_with_i`]: value => b => b.where(dbPath, 'REGEXP', `${f(value)}$`),
            [`${this.path}_not_ends_with_i`]: value => b =>
                b.where(dbPath, 'NOT REGEXP', `${f(value)}$`).orWhereNull(dbPath),
        };
    }
}

module.exports = {
    KnexAdapter: KnexAdapterExtended,
    KnexListAdapter: MysqlCompatibleKnexListAdapter,
    KnexFieldAdapter: MysqlCompatibleKnexFieldAdapter
};
