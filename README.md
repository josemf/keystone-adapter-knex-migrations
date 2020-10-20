# Keystone knex adapter with migrations support



This adapter extends the original Knex adapter developed within Keystone monorep and available at https://github.com/keystonejs/keystone/tree/master/packages/adapter-knex.

It provides the following commands:

`$ npx keystone-knex migrations-create ` &mdash; Automatically generates migration files required to update the database schema according to defined lists. Migration files are kept in a folder.

`$ npx keystone-knex migrations-do` &mdash; Uses any migrations defined in the migrations folder and applies one by one to the database schema.

!! WORD OF ATTENTION !!

This is still highly experimental and should be used with care. If you're going to use this tool in a production database system <u>please perform a backup</u> first.

## Simple steps

We require a special list to be defined. 

```javascript
keystone.createList('InternalSchema', {
    schemaDoc: 'It keeps track all schema versions mapped to database at some point. This is used by `migrations-create` to compare against the defined list schemas.',
    fields: {
        content: { type: Text, isRequired: true, schemaDoc: 'The schema content as a JSON string' },
        createdAt: { type: DateTimeUtc, isRequired: true, schemaDoc: 'A datetime on the moment a schema have been applied to the database' }
    }
});
```

And the adapter to be instantiated with some options.

```javascript
const Adapter = require('keystone-adapter-knex-migrations');

const adapterConfig = {    
    knexOptions: {
        connection: 'postgres://postgres:postgres@db/postgres'
    },

    knexMigrationsOptions: {
        migrationsFilePath: './compiled/migrations.json',
        migrationsSchemaFilePath: './compiled/schema.json',
        schemaTableName: "InternalSchema"                  
    }
};

const keystone = new Keystone({
    adapter: new Adapter(adapterConfig),
});
```

We support the options:

* knexMigrationsOptions.migrationsFilePath &mdash; This is the file path where the migrations will be stored
* knexMigrationsOptions.migrationsSchemaFilePath &mdash; This is the file path where a schema object will be stored. Schema objects are an intermediary format generated from keystone lists that are used to perform migrations generation.
* knexMigrationsOptions.schemaTableName &mdash; This is the name of the list that is used to store schema objects (also used as the database table name).



