<div align="center">
  <h1>KeystoneJs Knex-Ext</h1>
  <br>
  <p><b>Brings MySQL support and database migrations to <a href="https://www.keystonejs.com/">KeystoneJS</a></b></p>
  <p><code>$ keystone-knex migrate</code></p>
</div>
## Contents

- [What's in](#whats-in)
- [Getting Started](#getting-started)
- [Supported Features](#supported-features)
- [Roadmap](#roadmap)
- [Testing](#testing)
- [Contributing](#contributing)
- [License](#license)

## What's in 

We extended the official supported [adapter-knex](https://github.com/keystonejs/keystone/tree/master/packages/adapter-knex) database adapter and included both **MySQL complete support** and a [database migrations](https://en.wikipedia.org/wiki/Schema_migration) mechanism.

Database schema migrations are code generated by comparing previous database schema versions and the current working KeystoneJS lists. Incremental schema changes might be **immediately applied**, asked **one by one** or presented as **SQL statements** so the developers can review and have full control on their database schemas. 

Command line tooling include a revised `keystone create-tables` command that fully supports MySQL and migration specific commands to migrate, rollback and forward database schema migrations.

```bash
# keystone-knex --help
Usage
  $ keystone-knex <command>

Available commands [default: migrate]
  migrate-forward, migrate-rollback, migrate

Common Options
  --version       Version number
  --help, -h      Displays this message

Commands
  migrate-forward
    Usage
      $ keystone-knex migrate-forward
    
    Options
      --entry       Entry file exporting keystone instance
      --mode        Operation mode [migrate | sql | ask | silent]
      --sqlPath     Path to save SQL
      
  migrate-rollback
    Usage
      $ keystone-knex migrate-rollback
    
    Options
      --entry       Entry file exporting keystone instance
      --mode        Operation mode [migrate | sql | ask | silent]
      --sqlPath     Path to save SQL

  migrate
    Usage
      $ keystone-knex migrate
    
    Options
      --entry       Entry file exporting keystone instance
      --mode        Operation mode [migrate | sql | ask | silent]
      --sqlPath     Path to save SQL
```

## Getting started

For new projects [start as usual](https://www.keystonejs.com/quick-start/) by running the commands. You can use any of KeystoneJS templates.

```bash
yarn create keystone-app my-app
cd my-app
```

Then add the adapter.

```bash
yarn add keystone-adapter-knex-migrations
```

And configure the adapter in your project main file.

```javascript
const { Keystone } = require('@keystonejs/keystone');
const { PasswordAuthStrategy } = require('@keystonejs/auth-password');
const { Text, Checkbox, Password } = require('@keystonejs/fields');
const { GraphQLApp } = require('@keystonejs/app-graphql');
const { AdminUIApp } = require('@keystonejs/app-admin-ui');
const initialiseData = require('./initial-data');

// Require the adapter
const { KnexAdapter: Adapter } = require('keystone-adapter-knex-migrations');

const PROJECT_NAME = 'my-app';

// Postgres Database
//const adapterConfig = { knexOptions: { connection: 'postgres://localhost/cd_my_app' } };

// MySQL Database
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
    }
};  

// Instantiate Keystone with the adapter
const keystone = new Keystone({
  adapter: new Adapter(adapterConfig),
  onConnect: process.env.CREATE_TABLES !== 'true' && initialiseData,
});

// >>>>>>>>>>>>>>>>> Lists 

const userIsAdmin = ({ authentication: { item: user } }) => Boolean(user && user.isAdmin);
const userOwnsItem = ({ authentication: { item: user } }) => {
  if (!user) {
    return false;
  }

  return { id: user.id };
};

const userIsAdminOrOwner = auth => {
  const isAdmin = access.userIsAdmin(auth);
  const isOwner = access.userOwnsItem(auth);
  return isAdmin ? isAdmin : isOwner;
};

const access = { userIsAdmin, userOwnsItem, userIsAdminOrOwner };

keystone.createList('User', {
  fields: {
    name: { type: Text },
    email: {
      type: Text,
      isUnique: true,
    },
    isAdmin: {
      type: Checkbox,
      // Field-level access controls
      // Here, we set more restrictive field access so a non-admin cannot make themselves admin.
      access: {
        update: access.userIsAdmin,
      },
    },
    password: {
      type: Password,
    },
  },
  // List-level access controls
  access: {
    read: access.userIsAdminOrOwner,
    update: access.userIsAdminOrOwner,
    create: access.userIsAdmin,
    delete: access.userIsAdmin,
    auth: true,
  },
});

// >>>>>>>>>>>>>>> End of Lists

const authStrategy = keystone.createAuthStrategy({
  type: PasswordAuthStrategy,
  list: 'User',
  config: { protectIdentities: process.env.NODE_ENV === 'production' },
});

module.exports = {
  keystone,
  apps: [
    new GraphQLApp(),
    new AdminUIApp({
      name: PROJECT_NAME,
      enableDefaultRoute: true,
      authStrategy
    }),
  ],
};

```

A database table `SchemaVersion` is created in your database. This table will keep previous database schemas.

You can start by adding your own lists and changing previous lists:

```javascript
// ...
keystone.createList('User', {
  fields: {
      name: { type: Text, isRequired: true },
    email: {
      type: Text,
      isUnique: true,
      isRequired: true
    },
    password: {
      type: Password,
    },
    todo: { type: Relationship, ref: 'Todo.user', many: true},
    role: { type: Relationship, ref: 'Role', many: false }      
  },
  // List-level access controls
  access: {
    read: access.userIsAdminOrOwner,
    update: access.userIsAdminOrOwner,
    create: access.userIsAdmin,
    delete: access.userIsAdmin,
    auth: true,
  },
});

keystone.createList('Role', { 
  fields: {
    name: { type: Text, isUnique: true, isRequired: true },
    description: { type: Text },
    isAdmin: { type: Checkbox, defaultValue: false }
  },
});

keystone.createList('Todo', {  
  fields: {
    name: { type: Text }, 
    category: { type: Relationship, ref: 'Category.todo', many: false },  
    user: { type: Relationship, ref: 'User.todo', many: false },
    createdAt: { type: DateTime }
  },    
});   
   
keystone.createList('Category', { 
  fields: {  
    name: { type: Text, isIndexed: true  },
    todo: { type: Relationship, ref: 'Todo.category', many: true },
  },  
}); 

// ...
```

And run the `migrate` command.

```
keystone-knex migrate
ℹ Command: keystone migrate
ℹ Generating migrations from latest point.
ℹ Those are your migrations:

	+ TABLE Role (id integer pk autoincrements NOT NULL, name string UNIQUE, NOT NULL, description text, isAdmin boolean NOT NULL)
	+ TABLE Todo (id integer pk autoincrements NOT NULL, name text, createdAt_utc timestamp(useTz: false, precision: 6), createdAt_offset text)
	+ TABLE Category (id integer pk autoincrements NOT NULL, name string INDEX)

	M FIELD ON User (name text → name text NOT NULL)
	M FIELD ON User (email string UNIQUE → email string UNIQUE, NOT NULL)
	— FIELD ON User (isAdmin boolean)

	+ RELATION N:1 BETWEEN User todo AND Todo user
	+ RELATION N:1 BETWEEN User role AND Role
	+ RELATION 1:N BETWEEN Todo category AND Category todo

ℹ MIGRATE Mode. We will change your database schema according to every migration.

? You want to proceed? › (Y/n)
```

Press `Y` and it's migrated.

However you might want to have more control on what SQL statements are being applied to your database.

```
keystone-knex migrate --mode ask
ℹ Command: keystone migrate --mode=ask
ℹ Generating migrations from latest point.
ℹ Those are your migrations:

	+ TABLE Role (id integer pk autoincrements NOT NULL, name string UNIQUE, NOT NULL, description text, isAdmin boolean NOT NULL)
	+ TABLE Todo (id integer pk autoincrements NOT NULL, name text, createdAt_utc timestamp(useTz: false, precision: 6), createdAt_offset text)
	+ TABLE Category (id integer pk autoincrements NOT NULL, name string INDEX)

	M FIELD ON User (name text → name text NOT NULL)
	M FIELD ON User (email string UNIQUE → email string UNIQUE, NOT NULL)
	— FIELD ON User (isAdmin boolean)

	+ RELATION N:1 BETWEEN User todo AND Todo user
	+ RELATION N:1 BETWEEN User role AND Role
	+ RELATION 1:N BETWEEN Todo category AND Category todo

ℹ ASK Mode. We will show all migrations SQL and ask if you want us to execute for you.

  create table `test`.`Role` (`id` int unsigned not null auto_increment primary key, `name` varchar(255) not null, `description` text, `isAdmin` boolean not null);
alter table `test`.`Role` add unique `role_name_unique`(`name`)

✔ You want to proceed? … yes

  create table `test`.`Todo` (`id` int unsigned not null auto_increment primary key, `name` text, `createdAt_utc` timestamp(6), `createdAt_offset` text)

✔ You want to proceed? … yes

  create table `test`.`Category` (`id` int unsigned not null auto_increment primary key, `name` varchar(255));
alter table `test`.`Category` add index `category_name_index`(`name`)

? You want to proceed? › (Y/n)
```

Press `Y` or `n` to every and you're up to go.

But say you just want to get a list of every SQL statement that would be applied to the database and do it yourself.

```
create table `test`.`Role` (`id` int unsigned not null auto_increment primary key, `name` varchar(255) not null, `description` text, `isAdmin` boolean not null);
alter table `test`.`Role` add unique `role_name_unique`(`name`);
create table `test`.`Todo` (`id` int unsigned not null auto_increment primary key, `name` text, `createdAt_utc` timestamp(6), `createdAt_offset` text);
create table `test`.`Category` (`id` int unsigned not null auto_increment primary key, `name` varchar(255));
alter table `test`.`Category` add index `category_name_index`(`name`);
alter table `test`.`User` modify `name` text not null;
alter table `test`.`User` modify `email` varchar(255) not null;
alter table `test`.`User` drop `isAdmin`;
alter table `test`.`Todo` add `user` int unsigned;
alter table `test`.`Todo` add index `todo_user_index`(`user`);
alter table `test`.`Todo` add constraint `todo_user_foreign` foreign key (`user`) references `User` (`id`);
alter table `test`.`User` add `role` int unsigned;
alter table `test`.`User` add index `user_role_index`(`role`);
alter table `test`.`User` add constraint `user_role_foreign` foreign key (`role`) references `Role` (`id`);
alter table `test`.`Todo` add `category` int unsigned;
alter table `test`.`Todo` add index `todo_category_index`(`category`);
alter table `test`.`Todo` add constraint `todo_category_foreign` foreign key (`category`) references `Category` (`id`);

insert into `test`.`SchemaVersion` (`active`, `content`, `createdAt`) values (...);
delete from `test`.`SchemaVersion` where `active` = false;
```

Any mode used, it is always possible to store the generated SQL code to a file using the command line argument `--sqlPath`.

```bash
keystone-knex migrate --mode sql --sqlPath './output.sql'
ℹ Command: keystone migrate --mode=sql --sqlPath=./output.sql
ℹ Generating migrations from latest point.
ℹ Those are your migrations:

	+ TABLE Role (id integer pk autoincrements NOT NULL, name string UNIQUE, NOT NULL, description text, isAdmin boolean NOT NULL)
	+ TABLE Todo (id integer pk autoincrements NOT NULL, name text, createdAt_utc timestamp(useTz: false, precision: 6), createdAt_offset text)
	+ TABLE Category (id integer pk autoincrements NOT NULL, name string INDEX)

	M FIELD ON User (name text → name text NOT NULL)
	M FIELD ON User (email string UNIQUE → email string UNIQUE, NOT NULL)
	— FIELD ON User (isAdmin boolean)

	+ RELATION N:1 BETWEEN User todo AND Todo user
	+ RELATION N:1 BETWEEN User role AND Role
	+ RELATION 1:N BETWEEN Todo category AND Category todo

ℹ SQL Mode. No migrations have been applied to your database.

ℹ The SQL queries are saved here: /path-to-my-app/output.sql

✔ Done.
```

## Supported Features

You can get the SQL statements if you don't want to risk a blind migrate. **This is the recommended** with production databases.

There are lot of scenarios to implement when creating a database migrations tool. We've put a big effort into supporting most migration use cases and also taking care of things like copying data around database tables when a relationship change might introduce differences on how relationship data is stored in the database.

We support **adding lists**, **dropping lists**, **adding fields to lists**, **renaming fields in lists**, **removing fields** from lists and **changing field definitions in lists** like changing the type or supported options such as `isUnique` and `defaultValue`.

We support **all field definitions** that are builtin in KeystoneJS and third party packages whenever they are supported by `adapter-knex`.

We support **adding relationships**, **removing relationships**, **renaming relationships** and **changing its directions and cardinality**. Association data will be copied around everytime it is possible.

We support **transforming relationship fields** into scalar fields. We support **transforming scalar fields** into relationship fields. Preserving existing data assumes a `name` field in the relationship field target table. We want to improve this.

Migrations can be `rollback`. After being rollback they can be `forward`ed. At some point que database schema state might not be in sync with your lists. You can always get to the working list schema if you run `migrate`.

## Roadmap

We are looking to improve the adapter and the migrations framework.

* Implement more unit testing to the migration framework. MySQL unit testing support is implemented using `@keystonejs` test suite.
* Better support for two column fields such as `DateTime`. Miss rename support but should add and remove fine.
* Renaming lists.
* Database transactions.

If you have any feature you would love to include here please feel free to suggest.

## Testing

There are a few docker scripts in the `tests/bin` folder you might use to start a database engine.

```bash
$ yarn test-mysql
$ yarn test-postgres
```

## Contributing

By now I would be happy to have people using this code and submitting bug reports and feature requests. But I will always invite people to fix things themselves or implement different features by sending PRs.

Thanks for your help!

## License

Copyright (c) 2021 José da Mata. Licensed under the MIT License.