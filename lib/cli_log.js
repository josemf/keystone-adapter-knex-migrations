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

    sql(text) {
        if(true === this._silent) return;

        console.log(text);
    }

    _buildOutputChainables(chainables) {

        const output = chainables.map(cc => {

            switch(cc.name) {
            case 'notNullable' :
                return 'NOT NULL';
            default:
                return cc.name.toUpperCase();
            }

        }).filter(ccc => !!ccc).join(", ");

        return output ? " " + chalk.dim(output) : "";
    }

    _buildOutputFieldArgs(args) {
        return `${args.length > 0 ? "(" + args.map(a => Object.keys(a).map(k => chalk.dim(`${k}: ${a[k]}`)).join(", " )).join(" ") + ')' : ''}`;
    }

    _buildOutputField(field) {

        const fieldConfigs = field.options.knexOptions.config;
        const output = fieldConfigs.map(o => {
            return `${chalk.underline(o.args[0])} ${chalk.bold(o.method === 'increments' ? 'integer pk autoincrements' : o.method)}${this._buildOutputFieldArgs(o.args.slice(1))}${this._buildOutputChainables(o.chainables)}`;
        }).join(", ");

        return output;
    }

    _buildOutputObjectOperation(operation, output) {
        switch(operation) {
        case 'create':
            return chalk.green.bold("+") + " " + output;
        case 'remove':
            return chalk.red.bold("\u2014") + " " + output;
        case 'rename' :
        case 'update' :
            return chalk.yellow.bold("M") + " " + output;
        }

        return chalk.yellow.bold("?") + " " + output;
    }

    _buildOutputList(list) {
        const output = `TABLE ${chalk.underline.bold(list.options.tableName || list.name)} (${list.fields.map(f => this._buildOutputField(f)).join(', ')})`;

        return this._buildOutputObjectOperation(list.op, output);
    }

    _buildOutputAssociation(association) {

        let output;

        if('create' === association.op || 'remove' === association.op) {

            output = `RELATION ${chalk.dim(association.cardinality)} BETWEEN ${chalk.underline.bold(association.name)} ${chalk.underline(association.field)} AND ${chalk.underline.bold(association.reference.list)}${association.reference.field ? ' ' + chalk.underline(association.reference.field) : ''}`;

        } else {

            const beforeOutput = association.before.type === "Relationship" ?
                  `${chalk.dim(association.before.cardinality)} BETWEEN ${chalk.underline.bold(association.name)} ${chalk.underline(association.before.name)} AND ${chalk.underline.bold(association.before.reference.list)}${association.before.reference.field ? ' ' + chalk.underline(association.before.reference.field) : ''}` :
                  `${chalk.underline.bold(association.name)} (${this._buildOutputField(association.before)})`;

            const afterOutput = association.target.type === "Relationship" ?
                  `${chalk.dim(association.target.cardinality)} BETWEEN ${chalk.underline.bold(association.name)} ${chalk.underline(association.target.name)} AND ${chalk.underline.bold(association.target.reference.list)}${association.target.reference.field ? ' ' + chalk.underline(association.target.reference.field) : ''}` :                  
                  `${chalk.underline.bold(association.name)} (${this._buildOutputField(association.target)})`;            

            const relationOutput = association.target.type === "Relationship" ?
                  `RELATION` :
                  `RELATION DROP`; 
            
            output = `${relationOutput} ${beforeOutput} \u2192 ${afterOutput}`;
        }

        return this._buildOutputObjectOperation(association.op, output);
    }

    _buildOutputFieldObject(field) {

        let output;

        if('rename' === field.op || 'update' === field.op) {

            output = `FIELD ON ${chalk.underline.bold(field.list)} (${this._buildOutputField(field.before)} \u2192 ${this._buildOutputField(field.field)})`;

        } else {

            output = `FIELD ON ${chalk.underline.bold(field.list)} (${this._buildOutputField(field.field)})`;

        }

        return this._buildOutputObjectOperation(field.op, output);
    }

    _logObject(output) {
        if(true === this._silent) return;
        
        console.log(`\t${output}`);
    }

    newLine() {
        if(true === this._silent) return;
        
        console.log("");
    }

    objects(oo) {
        let prevOb = '';

        oo.forEach(o => {

            if(prevOb && prevOb !== o.object) {
                this.newLine();
            }

            this.object(o);

            prevOb = o.object;
        });
    }

    object(o) {

        if(true === this._silent) return;
        
        if(this._spinner) {

            let output = '';

            switch(o.object) {
            case 'list':
                output = this._buildOutputList(o);
                break;
            case 'association':
                output = this._buildOutputAssociation(o);
                break;
            case 'field':
                output = this._buildOutputFieldObject(o);
                break;
            default:
                console.log(o);
            }

            this._logObject(output);

        }
    }
}

module.exports = CliLog;
