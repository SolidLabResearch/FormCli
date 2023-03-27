#!/usr/bin/env node

import yargs from 'yargs';
import {hideBin} from 'yargs/helpers'
import {
    confirmSubmit,
    loadContentOfUrl,
    parseForm,
    printAnswers,
    promptField,
    queryDataForField
} from "../src/index.js";
import {n3reasoner} from "eyereasoner";
import {v4} from "uuid";

const options = yargs(hideBin(process.argv))
    .usage("Usage: -d <dataset URL> -f <form description> -r <N3 Conversion Rules>")
    .option("d", {alias: "data", describe: "Dataset URL", type: "string", demandOption: true})
    .option("r", {alias: "rules", describe: "N3 Conversion Rules URL", type: "string", demandOption: false})
    .option("f", {alias: "form", describe: "Form description URI", type: "string", demandOption: true})
    .argv;

(async () => {
    if (options.data && options.form) {
        console.log("Dataset URL: ", options.data);
        console.log("N3 Conversion Rules URL: ", options.rules);
        console.log("Form description URL: ", options.form);

        const n3doc = await loadContentOfUrl(options.data);
        let n3form = await loadContentOfUrl(options.form);

        if (options.rules) {
            const n3rules = await loadContentOfUrl(options.rules);

            // Add base to doc if not yet. Fixing relative IRIs.
            if (!n3form.includes("@base") && !n3form.includes("BASE")) {
                n3form = `@base <${this.doc}#> .\n${n3form}`;
            }

            const options = {blogic: false, outputType: "string"};
            n3form = await n3reasoner(n3form, n3rules, options);
        }

        const fields = await parseForm(n3form, options.form);

        for (const field of fields) {
            const data = await queryDataForField(n3doc, field, options.data);
            if (!field.multiple && data.length > 1) {
                console.error(`Multiple values found for ${field.label} while only one is expected.`);
            }
            field.values = data || [];

            if (field.required && !field.values.length) {
                field.values = [{value: undefined, subject: `${options.data}#${v4()}`}];
            }
        }

        let confirm = false;
        while (!confirm) {
            for (const field of fields) {
                await promptField(field);
                printAnswers(field);
                console.log("\n");
            }

            console.log("Final answers:");
            for (const field of fields) {
                printAnswers(field);
            }

            confirm = await confirmSubmit();
        }

        // Submit answers
        // TODO: Implement
    }
})();
