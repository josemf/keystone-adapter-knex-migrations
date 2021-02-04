const { Keystone } = require('@keystonejs/keystone');
const { Text, Relationship, Select, Integer, Decimal, DateTime, DateTimeUtc, Checkbox } = require('@keystonejs/fields');
const { GraphQLApp } = require('@keystonejs/app-graphql');

const { KnexAdapter: Adapter } = require('../..');

const PROJECT_NAME = 'my-app';
const adapterConfig = {

    knexOptions: {

        client: 'mysql',
        connection: {
            host: 'localhost',
            user: 'root',
            password: 'mysql',
            database: 'test',
            port: 3306
        }
    },

    knexMigrationsOptions: {
        migrationsFilePath: './compiled/migrations.json',
        migrationsSchemaFilePath: './compiled/schema.json',
        schemaTableName: "SchemaVersion"
    }
};

function build(keystone) {

    keystone.createList('Todo', {
        fields: {
            name: { type: Text },
            category: { type: Relationship, ref: 'Category.todo', many: false },
            user: { type: Relationship, ref: 'User.todo', many: true },
            createdAt: { type: DateTime }
        },
    });

    keystone.createList('Category', {
        fields: {
            name: { type: Text, isUnique: true  },
            todo: { type: Relationship, ref: 'Todo.category', many: true },
            term: { type: Relationship, ref: 'CategoryTerm', many: true }
        },
    });

    keystone.createList('CategoryTerm', {
        fields: {
            name: { type: Text, isIndexed: true  },
        },
    });

    keystone.createList('User', {
        fields: {
            name: { type: Text, isUnique: true  },
            todo: { type: Relationship, ref: 'Todo.user', many: true},
            role: { type: Relationship, ref: 'Role.user', many: true },
        },
    });

    keystone.createList('Role', {
        fields: {
            name: { type: Text, isUnique: true, isRequired: true },
            description: { type: Text },
            isAdmin: { type: Checkbox },
            user: { type: Relationship, ref: "User.role", many: true }
        },
    });
}

const keystone = new Keystone({
    adapter: new Adapter(adapterConfig),
    cookieSecret: "secr3t."
});

build(keystone);

module.exports = {
    keystone,
    apps: [
        new GraphQLApp(),
    ],
    build: build
};
