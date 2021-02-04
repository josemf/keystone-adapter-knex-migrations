const { gen, sampleOne } = require('testcheck');

const { Text, Relationship } = require('@keystonejs/fields');
const { multiAdapterRunners, setupServer } = require('../utils');
const { createItem, createItems } = require('@keystonejs/server-side-graphql-client');

const { exec } = require("child_process");

const _ = require('lodash');

const alphanumGenerator = gen.alphaNumString.notEmpty();

const Lists = {
    Post: {
        fields: {
            title: { type: Text },
            author: { type: Relationship, ref: 'User' },
        }
    },
    User: {
        fields: {
            name: { type: Text },
            feed: { type: Relationship, ref: 'Post', many: true },
        }        
    }
};

async function setupKeystone(adapterName) {

    // Lets exec as command that create the initial database

    const appPath = `${__dirname}/app-initial.js`;
    
    await new Promise((resolve, reject) => {
        
        exec(`keystone-knex migrations-create --mode silent --entry ${appPath}`, (error, stdout, stderr) => {
            if (error) {
                reject({error, stderr});                
                return;
            }

            resolve(stdout);
        });       
    });

    return setupServer({
        adapterName,
        method: "migrate",
        createLists: keystone => {

            const { build } = require(appPath);

            build(keystone);
        },
    });
}
                     

function mergeFieldsToList(keystone, list, fields = { fields: {}}) {
    keystone.createList(list, _.merge({}, Lists[list], fields));
}

multiAdapterRunners().map(({ runner, adapterName }) => {

    /* TODO: Seems that @keystonejs/keystone version doesn't match used the adapter */
    
    describe.skip(`Adapter: ${adapterName}`, () => {

        describe('Add fields to list', () => {

            test(
                'Migrate: single field',
                runner(setupKeystone, async ({ keystone }) => {
                            
                                        

                    
                    
                    /*
 
                    // Create an item to link against
                    const users = await createItems({
                    keystone,
                    listKey: 'User',
                    items: [
                    { data: { name: 'Jess' } },
                    { data: { name: 'Johanna' } },
                    { data: { name: 'Sam' } },
                    ],
                    });
                    const posts = await createItems({
                    keystone,
                    listKey: 'Post',
                    items: [
                    {
                    data: {
                    author: { connect: { id: users[0].id } },
                    title: sampleOne(alphanumGenerator),
                    },
                    },
                    {
                    data: {
                    author: { connect: { id: users[1].id } },
                    title: sampleOne(alphanumGenerator),
                    },
                    },
                    {
                    data: {
                    author: { connect: { id: users[2].id } },
                    title: sampleOne(alphanumGenerator),
                    },
                    },
                    {
                    data: {
                    author: { connect: { id: users[0].id } },
                    title: sampleOne(alphanumGenerator),
                    },
                    },
                    ],
                    returnFields: 'id title',
                    });

                    // Create an item that does the linking
                    const { data, errors } = await keystone.executeGraphQL({
                    query: `
                    query {
                    allPosts(where: {
                    author: { name_contains: "J" }
                    }) {
                    id
                    title
                    }
                    }
                    `,
                    });

                    expect(errors).toBe(undefined);
                    expect(data).toHaveProperty('allPosts');
                    expect(data.allPosts).toHaveLength(3);

                    const { allPosts } = data;

                    // We don't know the order, so we have to check individually
                    expect(allPosts).toContainEqual({ id: posts[0].id, title: posts[0].title });
                    expect(allPosts).toContainEqual({ id: posts[1].id, title: posts[1].title });
                    expect(allPosts).toContainEqual({ id: posts[3].id, title: posts[3].title });

                    */
                })
            );
        });
    });
}
                         );
