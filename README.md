# Keystone knex adapter with migrations support

This adapter extends the original Knex adapter developed within Keystone monorep and available at https://github.com/keystonejs/keystone/tree/master/packages/adapter-knex.

## What is this

Database migrations allows you to iteratively build your CMS objects and implement database schema changes iteratively without having to write database DDL code by hand. 

We implement database migrations for the existing Knex database provider by extending the Knex plugin class, this guarantees every previously available feature will be present, and includes a database migrations layer on top. The migrations we implement are generated from the current and past Keystone list schemas, which mean you wont have to manually write any migration code.

It provides the following commands:

`$ npx keystone-knex migrations-create ` &mdash; Automatically generates migration files required to update the database schema according to defined lists. Migration files are kept in a folder.

`$ npx keystone-knex migrations-do` &mdash; Uses any migrations defined in the migrations folder and applies one by one to the database schema.

## What works

!! WORD OF CAUTION !!

This is still highly experimental and should be used with care. If you're going to use this tool in a production database system <u>please perform a backup</u> first. That said we would love to have people using this tool and reporting bugs or having feature requests.

A lot of things works as of now:

* List migrations:
  * New lists will be created on the database
  * Removed lists from code will be removed from the database
* Field migrations:
  * Adding fields to lists will add the respective columns to the database
  * Remove fields from lists will remove the respective columns in the database
  * Renaming fields from lists will rename the respective columns in the database
  * Changing fields configuration like changing the field type or making the field `isRequired`, `isUnique` etc, will change the respective columns in the database
* Relationship migrations:
  * Adding relationships in lists will have this relationships mapped on the database using foreign keys columns or pivot tables depending on the cardinality
  * Changing relationship configurations like `isRequired` will have that change reflected onto the column foreign key
  * Changing relationship cardinalities will have database schema changes to be applied in a way that data is saved in the best way possible

Other things are not quite right:

* It's currently not possible to change from content fields to relationship fields and vice versa
* There are no rollback migrations &mdash; I expect to work on this soon
* You can't rename lists yet

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

Install with npm and git (this will be an npm package soon...) 

`$ npm i git+https://github.com/josemf/keystone-adapter-knex-migrations.git`

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

## Running the commands

Say we start with the starter **Todo** app:

```javascript
keystone.createList('Todo', {
    schemaDoc: 'A list of things which need to be done',
    fields: {
        name: { type: Text, schemaDoc: 'This is the thing you need to do' },
    },
});
```

We bootstrap the database by first creating the migrations and executing:

```yaml
$ npx keystone-knex migrations-create

ℹ Command: keystone migrations-create

ℹ Building lists schema file
ℹ Loading database schema so we can build the differences
ℹ A database schema wasnt found. It is a new database.
{
    object: list
    op: create
    name: InternalSchema
    options: 
        tableName: InternalSchema
    fields: 
        0: 
            type: AutoIncrementImplementation
            name: id
            options: 
                isPrimaryKey: true
                isRequired: false
                knexOptions: 
        1: 
            type: Text
            name: content
            options: 
                isPrimaryKey: false
                isRequired: true
                knexOptions: 
        2: 
            type: DateTimeUtcImplementation
            name: createdAt
            options: 
                isPrimaryKey: false
                isRequired: true
                knexOptions: 
}

{
    object: list
    op: create
    name: Todo
    options: 
        tableName: Todo
    fields: 
        0: 
            type: AutoIncrementImplementation
            name: id
            options: 
                isPrimaryKey: true
                isRequired: false
                knexOptions: 
        1: 
            type: Text
            name: name
            options: 
                isPrimaryKey: false
                isRequired: false
                knexOptions: 
}

✔ Done.
```

Everything is highly verbose. At this points because this is experimental and haven't been throughly used it is important to know exactly what is happening.

Then we run the migration:

```yaml
$ npx keystone-knex migrations-do

ℹ Command: keystone migrations-do
⠹  Executing list migration files...
ℹ Starting to apply migrations
ℹ Migrating:
{
    object: list
    op: create
    name: InternalSchema
    options: 
        tableName: InternalSchema
    fields: 
        0: 
            type: AutoIncrementImplementation
            name: id
            options: 
                isPrimaryKey: true
                isRequired: false
                knexOptions: 
        1: 
            type: Text
            name: content
            options: 
                isPrimaryKey: false
                isRequired: true
                knexOptions: 
        2: 
            type: DateTimeUtcImplementation
            name: createdAt
            options: 
                isPrimaryKey: false
                isRequired: true
                knexOptions: 
}

✔ Can you confirm? … yes
* Creating table InternalSchema
ℹ Migrated.
ℹ Migrating:
{
    object: list
    op: create
    name: Todo
    options: 
        tableName: Todo
    fields: 
        0: 
            type: AutoIncrementImplementation
            name: id
            options: 
                isPrimaryKey: true
                isRequired: false
                knexOptions: 
        1: 
            type: Text
            name: name
            options: 
                isPrimaryKey: false
                isRequired: false
                knexOptions: 
}

✔ Can you confirm? … yes
* Creating table Todo
ℹ Migrated.
✔ Done.
```

We ask for confirmation every migration.

Now we want to extend our models so Todo items can be associated to categories:

```javascript

keystone.createList('Todo', {
    schemaDoc: 'A list of things which need to be done',
    fields: {
        name: { type: Text, schemaDoc: 'This is the thing you need to do' },
        priority: { type: Integer, isRequired: true },
        category: { type: Relationship, ref: 'Category.todo', many: false }
    },
});

keystone.createList('Category', {
    schemaDoc: 'The category of the Todo',
    fields: {
        name: { type: Text, schemaDoc: 'The user full name' },        
        todo: { type: Relationship, ref: 'Todo.category', many: true }
    },
});

```

And we run the command line tools again:

```yaml
$ npx keystone-knex migrations-create

ℹ Building lists schema file
ℹ Loading database schema so we can build the differences
ℹ Loaded.
{
    object: field
    op: create
    name: priority
    list: Todo
    options: 
    field: 
        type: Integer
        name: priority
        options: 
            isPrimaryKey: false
            isRequired: true
            knexOptions: 
}

{
    object: list
    op: create
    name: Category
    options: 
        tableName: Category
    fields: 
        0: 
            type: AutoIncrementImplementation
            name: id
            options: 
                isPrimaryKey: true
                isRequired: false
                knexOptions: 
        1: 
            type: Text
            name: name
            options: 
                isPrimaryKey: false
                isRequired: false
                knexOptions: 
}

{
    object: association
    op: create
    name: Category
    cardinality: 1:N
    field: todo
    target: 
        list: Todo
        referenced: category
}

✔ Done.

$ npx keystone-knex migrations-do


```



## Known Bugs

I will be updating this list for things I found not to be working properly but I don't want to tackle right way because they seem less priority

* Renaming self referring relationships is not working for all relationships that have back referring. This is the cases when for example we want to have two fields that act as referring to the list they belong, like we would to to implement hierarchical categories with `parent` and `childCategories` 

Thanks :pizza:

