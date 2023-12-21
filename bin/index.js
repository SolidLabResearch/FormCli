#!/usr/bin/env node

import yargs from 'yargs';
import {hideBin} from 'yargs/helpers'
import {
    confirmSubmit,
    getSubject,
    loadContentOfUrl,
    parseForm,
    printAnswers,
    promptField,
    queryDataForField,
    submit
} from "../src/index.js";
import {n3reasoner} from "eyereasoner";

const options = yargs(hideBin(process.argv))
    .usage("Usage: -d <dataset URL> -f <form description> -r <N3 Conversion Rules>")
    .option("d", {alias: "data", describe: "Dataset URL", type: "string", demandOption: false})
    .option("r", {alias: "rules", describe: "N3 Conversion Rules URL", type: "string", demandOption: false})
    .option("f", {alias: "form", describe: "Form description URI", type: "string", demandOption: true})
    .argv;

(async () => {
    if (options.form) {
        console.log("Dataset URL: ", options.data);
        console.log("N3 Conversion Rules URL: ", options.rules);
        console.log("Form description URL: ", options.form);

        const n3doc = options.data ? await loadContentOfUrl(options.data) : "";
        let n3form = await loadContentOfUrl(options.form);
        const originalForm = n3form;

        const rules = options.rules;
        if (rules) {
            const n3rules = await loadContentOfUrl(rules);

            // Add base to doc if not yet. Fixing relative IRIs.
            if (!n3form.includes("@base") && !n3form.includes("BASE")) {
                n3form = `@base <${this.doc}> .\n${n3form}`;
            }

            const options = {outputType: "string"};
            n3form = await n3reasoner(n3form, n3rules, options);
        }

        const {fields, formTargetClass} = await parseForm(n3form, options.form);

        for (const field of fields) {
            const data = await queryDataForField(n3doc, field, options.data, formTargetClass);
            if (!field.multiple && data.length > 1) {
                console.error(`Multiple values found for ${field.label} while only one is expected.`);
            }
            field.values = data || [];
        }

        const originalFields = JSON.parse(JSON.stringify(fields));

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

        // Get subject for data
        const subject = await getSubject(formTargetClass, n3doc);
        console.log('\x1b[1mSubject\x1b[0m');
        console.log(`- ${subject}`);

        // Submit answers
        await submit(originalForm, options.form, fields, formTargetClass, subject, originalFields);
    }
})();
