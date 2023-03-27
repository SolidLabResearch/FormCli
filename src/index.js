import { QueryEngine } from '@comunica/query-sparql';
import inquirer from 'inquirer';
import DatePrompt from "inquirer-date-prompt";

inquirer.registerPrompt("date", DatePrompt);

const engine = new QueryEngine();

export async function loadContentOfUrl(url) {
    const response = await fetch(url, {
        cors: "cors",
    });
    let content = await response.text();

    // Add base to doc if not yet. Fixing relative IRIs.
    if (!content.includes("@base") && !content.includes("BASE")) {
        content = `@base <${url.split("#")[0]}#> .\n${content}`;
    }
    return content;
}

export async function parseForm(n3form, formUrl) {
    const query = `
      PREFIX ui: <http://www.w3.org/ns/ui#>
      PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
      SELECT ?type ?property ?label ?from ?required ?multiple ?sequence WHERE {
        <${formUrl}> ui:parts ?list .
        ?list rdf:rest*/rdf:first ?field .
        ?field a ?type;
          ui:property ?property.
        OPTIONAL { ?field ui:label ?label. }
        OPTIONAL { ?field ui:from ?from. }
        OPTIONAL { ?field ui:required ?required. }
        OPTIONAL { ?field ui:multiple ?multiple. }
        OPTIONAL { ?field ui:sequence ?sequence. }
      }
      `;

    const bindings = await (
        await engine.queryBindings(query, {
            sources: [
                {
                    type: "stringSource",
                    value: n3form,
                    mediaType: "text/n3",
                    baseIRI: formUrl.split("#")[0] + "#",
                },
            ],
        })
    ).toArray();

    const fields = bindings.map((row) => {
        return {
            type: row.get("type").value.split("#")[1],
            property: row.get("property").value,
            label: row.get("label")?.value,
            from: row.get("from")?.value,
            required: row.get("required")?.value === "true",
            multiple: row.get("multiple")?.value === "true",
            sequence: parseInt(row.get("sequence")?.value),
        };
    });

    // Sort fields by sequence
    fields.sort((a, b) => a.sequence - b.sequence);

    // Add options to Choice fields
    for (const field of fields) {
        if (field.type === "Choice") {
            field.options = [];
            const query = `
          PREFIX ui: <http://www.w3.org/ns/ui#>
          PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
          PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
          SELECT ?value ?label WHERE {
            ?value a <${field.from}> ;
              skos:prefLabel ?label.
          }
          `;

            const bindings = await (
                await engine.queryBindings(query, {
                    sources: [
                        {
                            type: "stringSource",
                            value: n3form,
                            mediaType: "text/n3",
                            baseIRI: formUrl.split("#")[0] + "#",
                        },
                    ],
                })
            ).toArray();

            field.options = bindings.map((row) => {
                return {
                    value: row.get("value").value,
                    label: row.get("label").value,
                };
            });
        }
    }

    return fields;
}

export async function queryDataForField(data, field, doc) {
    const query = `
      SELECT ?s ?value WHERE {
        ?s <${field.property}> ?value.
      }
      `;

    const bindings = await (
        await engine.queryBindings(query, {
            sources: [
                {
                    type: "stringSource",
                    value: data,
                    mediaType: "text/n3",
                    baseIRI: doc.split("#")[0] + "#",
                },
            ],
        })
    ).toArray();

    return bindings.map((row) => {
        return {
            subject: row.get("s").value,
            value: row.get("value").value,
        };
    });
}

export async function promptField(field) {
    let done = false;
    while (!done) {
        printAnswers(field);

        const questions = [
            {
                type: 'list',
                name: 'action',
                message: 'What do you want to do?',
                choices: [
                    {name: 'Add new', value: 'add'},
                    {name: 'Remove existing', value: 'remove'},
                    {name: 'Done', value: 'done'},
                ],
            },
        ];
        const action = await inquirer.prompt(questions);
        if (action.action === 'done') {
            done = true;
        }
        if (action.action === 'add') {
            await addNew(field);
        }
        if (action.action === 'remove') {
            const questions = [
                {
                    type: 'list',
                    name: 'value',
                    message: field.label,
                    choices: field.values.map((value, index) => {
                        return {name: parseValue(value.value, field), value: index};
                    }),
                },
            ];
            const answer = await inquirer.prompt(questions);
            field.values = field.values.filter((value, index) => index !== answer.value);
        }
    }
}

export function printAnswers(field) {
    // Print field label in bold
    console.log(`\x1b[1m${field.label}\x1b[0m`);
    // Print field values
    for (const value of field.values) {
        console.log(`- ${parseValue(value.value, field)}`);
    }
}

function parseValue(value, field) {
    if (field.type === "SingleLineTextField" || field.type === "MultiLineTextField") {
        return value;
    } else if (field.type === "Choice") {
        for (const option of field.options) {
            if (option.value === value) {
                return option.label;
            }
        }
    } else if (field.type === "DateField") {
        return new Date(value).toLocaleString();
    } else if (field.type === "BooleanField") {
        return value === "true" ? "Yes" : "No";
    } else {
        console.warn(`Unknown field type: ${field.type}`);
    }
}

async function addNew(field) {
    if (field.type === "Choice") {
        const questions = [
            {
                type: 'list',
                name: 'value',
                message: field.label,
                choices: field.options.map(option => {
                    return {name: option.label, value: option.value};
                }),
            },
        ];
        const answer = await inquirer.prompt(questions);
        field.values.push({value: answer.value});
        return;
    }
    if (field.type === "DateField") {
        const questions = [
            {
                type: 'date',
                name: 'value',
                message: field.label,
            },
        ];
        const answer = await inquirer.prompt(questions);
        field.values.push({value: answer.value.toISOString()});
        return;
    }
    if (field.type === "BooleanField") {
        const questions = [
            {
                type: 'confirm',
                name: 'value',
                message: field.label,
            },
        ];
        const answer = await inquirer.prompt(questions);
        field.values.push({value: answer.value ? "true" : "false"});
        return;
    }
    if (field.type === "SingleLineTextField" || field.type === "MultiLineTextField") {
        const questions = [
            {
                type: 'input',
                name: 'value',
                message: field.label,
            },
        ];
        const answer = await inquirer.prompt(questions);
        field.values.push({value: answer.value});
        return;
    }
    console.warn(`Unknown field type: ${field.type}`);
}

export async function confirmSubmit() {
    const questions = [
        {
            type: 'confirm',
            name: 'submit',
            message: 'Do you want to submit the form?',
        },
    ];
    const answer = await inquirer.prompt(questions);
    return answer.submit;
}
