const chalk = require('chalk');
const prompts = require('prompts');

class CliLog {
    constructor(spinner, silent = false) {
        this._spinner = spinner;
        this._silent = silent;
    }

    async confirm(text) {

        if(true === this._silent) {
            return true;
        }
        
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

        if(true === this._silent) return;
        
        if(this._spinner) {
            this._spinner.info(chalk.green.bold(text));
        } else {
            console.log(chalk.green.bold(text));
        }
    }

    warn(text) {

        if(true === this._silent) return;        
        
        if(this._spinner) {
            this._spinner.info(chalk.yellow.bold(text));
        } else {
            console.log(chalk.yellow.bold(text));
        }
    }
    
    error(text) {

        if(true === this._silent) return;
        
        if(this._spinner) {
            this._spinner.info(chalk.red.bold(text));
        } else {
            console.log(chalk.red.bold(text));
        }
    }

    object(o, level = 0) {

        if(true === this._silent) return;
        
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

    
