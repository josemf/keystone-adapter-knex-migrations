const { KnexAdapter } = require('@keystonejs/adapter-knex');

const MigrationBuilder   = require('./lib/migration_builder');
const MigrationExecution = require('./lib/migration_execution');

const fs = require('fs');

const MIGRATIONS_FILE_PATH = './compiled/migrations.json';
const MIGRATIONS_SCHEMA_FILE_PATH = './compiled/schema.json';
const DEFAULT_CACHE_SCHEMA_TABLE_NAME = "InternalSchema";

class KnexAdapterExtended extends KnexAdapter {

    constructor({ knexOptions = {}, schemaName = 'public' } = {}) {
        super({ knexOptions, schemaName });
    }

    async createMigrations() {

        const builder = new MigrationBuilder(this.listAdapters, this.knex, {
            cacheSchemaTableName: DEFAULT_CACHE_SCHEMA_TABLE_NAME
        });
        
        const { migrations, schema } = await builder.build();
        
        fs.writeFileSync(MIGRATIONS_FILE_PATH, JSON.stringify(migrations));
        fs.writeFileSync(MIGRATIONS_SCHEMA_FILE_PATH, JSON.stringify(schema));        
    }

    async doMigrations() {

        if(!fs.existsSync(MIGRATIONS_FILE_PATH)) {
            console.log(`Needs migrations file in place ${MIGRATIONS_FILE_PATH}`);
            return;
        }

        if(!fs.existsSync(MIGRATIONS_SCHEMA_FILE_PATH)) {
            console.log(`Needs migrations schema file in place ${MIGRATIONS_SCHEMA_FILE_PATH}`);
            return;
        }        

        const migrations = JSON.parse(fs.readFileSync(MIGRATIONS_FILE_PATH, "utf-8"));
        const schema = fs.readFileSync(MIGRATIONS_SCHEMA_FILE_PATH, "utf-8");
        
        const execution = new MigrationExecution(this.listAdapters, this.knex, {
            cacheSchemaTableName: DEFAULT_CACHE_SCHEMA_TABLE_NAME
        });
        await execution.apply(migrations, schema);
    }
}

module.exports = KnexAdapterExtended;
