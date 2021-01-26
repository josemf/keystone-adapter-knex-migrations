const path = require('path');
const chalk = require('chalk');
const { DEFAULT_ENTRY } = require('@keystonejs/keystone');
const { getEntryFileFullPath } = require('@keystonejs/keystone/bin/utils');
const { asyncForEach } = require('@keystonejs/utils');

const forwardMigrations = async (args, entryFile, spinner) => {

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

        if (!adapter.forwardMigrations) {
            spinner.info(chalk.yellow.bold(`forward-migrations requires the Knex Ext adapter`));            
            return;
        }
        try {
            await adapter.forwardMigrations(spinner);
        } catch (e) {
            spinner.fail(chalk.red.bold(`Some error occurred`));
            console.log(e);
            errors = true;
        }
    });
    if (!errors) {
        spinner.succeed(chalk.green.bold(`Done.`));
        process.exit(0);
    }
    process.exit(1);
};

module.exports = {
    // prettier-ignore
    spec: {
        '--entry':      String,
    },
    help: ({ exeName }) => `
    Usage
      $ ${exeName} migrations-forward

    Options
      --entry       Entry file exporting keystone instance [${DEFAULT_ENTRY}]
  `,
    exec: async (args, { exeName, _cwd = process.cwd() } = {}, spinner) => {
        spinner.text = 'Validating project entry file';
        const entryFile = await getEntryFileFullPath(args, { exeName, _cwd });
        spinner.start(' ');
        return forwardMigrations(args, entryFile, spinner);
    },
};
