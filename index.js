const { KnexAdapter } = require('@keystonejs/adapter-knex');

const MigrationBuilder   = require('./lib/migration_builder');
const MigrationExecution = require('./lib/migration_execution');

const fs = require('fs');

const MIGRATIONS_FILE_PATH = './compiled/migrations.json';
const MIGRATIONS_SCHEMA_FILE_PATH = './compiled/schema.json';
const DEFAULT_CACHE_SCHEMA_TABLE_NAME = "InternalSchema";

class KnexAdapterExtended extends KnexAdapter {
 
    constructor({ knexOptions = {}, knexMigrationsOptions = {}, schemaName = 'public' } = {}) {
        super({ knexOptions, schemaName });

        this._knexMigrationsOptions = Object.assign({}, {
            migrationsFilePath: MIGRATIONS_FILE_PATH,
            migrationsSchemaFilePath: MIGRATIONS_SCHEMA_FILE_PATH,
            schemaTableName: DEFAULT_CACHE_SCHEMA_TABLE_NAME            
        }, knexMigrationsOptions);
    }

    async createMigrations(spinner) { 
        
        const builder = new MigrationBuilder(this.listAdapters, this.knex, {
            cacheSchemaTableName: DEFAULT_CACHE_SCHEMA_TABLE_NAME,
            spinner
        });
        
        const { migrations, schema } = await builder.build();
        
        fs.writeFileSync(this._knexMigrationsOptions.migrationsFilePath, JSON.stringify(migrations));
        fs.writeFileSync(this._knexMigrationsOptions.migrationsSchemaFilePath, JSON.stringify(schema));        
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
        const schema = fs.readFileSync(this._knexMigrationsOptions.migrationsSchemaFilePath, "utf-8");
        
        const execution = new MigrationExecution(this.listAdapters, this.knex, {
            cacheSchemaTableName: this._knexMigrationsOptions.schemaTableName,
            spinner
        });
        await execution.apply(migrations, schema);
    }
}

module.exports = KnexAdapterExtended;
