const chalk = require('chalk');
const prompts = require('prompts');

class CliLog {
    constructor(spinner) {
        this._spinner = spinner;
    }

    async confirm(text) {

        const response = await prompts(
            {
                type: 'confirm',
                name: 'value',
                message: text,
                initial: true,
                onCancel: () => {
                    return false;
                },
            },
            {
                onCancel: () => {
                    process.exit(0);
                },
            }
        );
        
        return response.value;
    }
    
    info(text) {
        if(this._spinner) {
            this._spinner.info(chalk.green.bold(text));
        }
    }

    warn(text) {
        if(this._spinner) {
            this._spinner.info(chalk.yellow.bold(text));
        }
    }
    
    error(text) {
        if(this._spinner) {
            this._spinner.info(chalk.red.bold(text));
        }
    }

    object(o, level = 0) {

        if(this._spinner) {

            if(level === 0)            
                console.log(chalk.grey.bold("{"));
            
            Object.keys(o).forEach(k => {

                if(typeof o[k] === "object") {
                    console.log("    ".repeat(level + 1) + chalk.white.bold(`${k}: `));
                    this.object(o[k], level + 1);
                } else {                
                    console.log("    ".repeat(level + 1) + chalk.white.bold(`${k}: `) + chalk.cyan.bold(`${o[k]}`));
                }
            });

            if(level === 0) {
                console.log(chalk.grey.bold("}"));
                console.log("");
            }
        }
    }
}

module.exports = CliLog;

    
