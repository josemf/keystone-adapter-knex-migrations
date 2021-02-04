const fs = require('fs');
const path = require('path');
const chalk = require('chalk');
const { DEFAULT_ENTRY } = require('@keystonejs/keystone');
const { getEntryFileFullPath } = require('@keystonejs/keystone/bin/utils');
const { asyncForEach } = require('@keystonejs/utils');

const createMigrations = async (args, entryFile, spinner) => {
    
    if(typeof args['--mode'] !== "undefined" && !['migrate', 'sql', 'ask', 'silent'].includes(args['--mode'])) {
        spinner.fail(chalk.red.bold(`Wrong --mode argument. Accepts: \`migrate\`, \`sql\`, \`ask\` and \`silent\``));
        process.exit(1);
    }

    if(typeof args['--sqlPath'] === 'string') {

        const filePath = path.resolve(args['--sqlPath']);

        if(fs.existsSync(filePath)) {

            try {                
                fs.accessSync(filePath, fs.constants.W_OK);
            } catch (err) {
                spinner.fail(chalk.red.bold(`Wrong --sqlPath argument. File at ${args['--sqlPath']} is not writable.`));
                process.exit(1);            
            }                    
        } else  {

            const tmp = filePath.split(path.sep);
            tmp.pop();
            const filePathDir = tmp.join(path.sep);

            try {                
                fs.accessSync(filePathDir, fs.constants.W_OK);
            } catch (err) {
                spinner.fail(chalk.red.bold(`Wrong --sqlPath argument. File at ${args['--sqlPath']} is not writable.`));
                process.exit(1);            
            }                    
        }
    }
        
    // Allow the spinner time to flush its output to the console.
    await new Promise(resolve => setTimeout(resolve, 100));

    let keystone;
    const resolvedFromEntry = require(path.resolve(entryFile));
    
    if(typeof resolvedFromEntry === 'function') {
        keystone = resolvedFromEntry().keystone;
    } else {
        keystone = resolvedFromEntry.keystone;
    }
    
    await keystone.connect();
    
    let errors = false;
    
    await asyncForEach(Object.values(keystone.adapters), async adapter => {

        if (!adapter.migrate) {
            spinner.info(chalk.yellow.bold(`migrate requires the Knex Ext adapter`));            
            return;
        }
        try {
            await adapter.migrate(spinner, { mode: args['--mode'] || 'migrate', sqlPath: args['--sqlPath'] ? path.resolve(args['--sqlPath']) : undefined });
        } catch (e) {
            spinner.fail(chalk.red.bold(`Some error occurred`));
            console.log(e);
            errors = true;
        }
    });
    if (!errors) {
        if(args['--mode'] !== "silent") {
            spinner.succeed(chalk.green.bold(`Done.`));
        }
        process.exit(0);
    }
    process.exit(1);
};

module.exports = {
    // prettier-ignore
    spec: {
        '--entry':      String,
        '--mode' :      String,
        '--sqlPath':   String
    },
    help: ({ exeName }) => `
    Usage
      $ ${exeName} migrate

    Options
      --entry       Entry file exporting keystone instance
      --mode        Operation mode [migrate | sql | ask | silent]
      --sqlPath     Path to save SQL and DDL queries 
  `,
    exec: async (args, { exeName, _cwd = process.cwd() } = {}, spinner) => {
        spinner.text = 'Validating project entry file';
        const entryFile = await getEntryFileFullPath(args, { exeName, _cwd });
        spinner.start(' ');        
        return createMigrations(args, entryFile, spinner);
    },
};
