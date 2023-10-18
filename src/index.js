import { QueryEngine } from '@comunica/query-sparql';
import inquirer from 'inquirer';
import DatePrompt from "inquirer-date-prompt";
import {n3reasoner} from "eyereasoner";
import {v4} from "uuid";
import open from "open";

inquirer.registerPrompt("date", DatePrompt);

const engine = new QueryEngine();

export async function loadContentOfUrl(url) {
    const response = await fetch(url, {
        cors: "cors",
    });
    let content = await response.text();

    // Add base to doc if not yet. Fixing relative IRIs.
    if (!content.includes("@base") && !content.includes("BASE")) {
        content = `@base <${url.split("#")[0]}> .\n${content}`;
    }
    return content;
}

export async function parseForm(n3form, formUrl) {
    const query = `
      PREFIX ui: <http://www.w3.org/ns/ui#>
      PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
      SELECT ?targetClass ?type ?property ?label ?from ?required ?multiple ?sequence WHERE {
        <${formUrl}> ui:parts ?list ;
            ui:property ?targetClass .
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
                    baseIRI: formUrl.split("#")[0],
                },
            ],
        })
    ).toArray();

    let formTargetClass;
    const fields = bindings.map((row) => {
        formTargetClass = row.get("targetClass").value;
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
                            baseIRI: formUrl.split("#")[0],
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

    return { fields, formTargetClass };
}

export async function queryDataForField(data, field, doc, formTargetClass) {
    if (!doc) {
        // No data document, so no data to query
        return [];
    }
    const query = `
      SELECT ?value WHERE {
        ?s a <${formTargetClass}> ;
          <${field.property}> ?value.
      }
      `;

    const bindings = await (
        await engine.queryBindings(query, {
            sources: [
                {
                    type: "stringSource",
                    value: data,
                    mediaType: "text/n3",
                    baseIRI: doc.split("#")[0],
                },
            ],
        })
    ).toArray();

    return bindings.map((row) => {
        return {
            value: row.get("value").value,
        };
    });
}

export async function promptField(field) {
    let done = false;
    while (!done) {
        printAnswers(field);

        const choices = [];
        if (field.multiple || field.values.length === 0) {
            choices.push({name: 'Add new', value: 'add'});
        }
        if (field.values.length > 0) {
            choices.push({name: 'Remove existing', value: 'remove'});
        }
        if (!field.required || field.values.length > 0) {
            choices.push({name: 'Done', value: 'done'});
        }

        const questions = [
            {
                type: 'list',
                name: 'action',
                message: 'What do you want to do?',
                choices: choices,
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

export async function submit(form, formUrl, fields, formTargetClass, subject) {
    const options = { blogic: false, outputType: "string" };
    const reasonerResult = await n3reasoner(
        `PREFIX ex: <http://example.org/>\n<${formUrl}> ex:event ex:Submit .`,
        form,
        options
    );

    const policies = await parseSubmitPolicy(reasonerResult, formUrl);
    if (!policies) {
        console.warn("No ex:Submit policy found for this form.");
        return;
    }
    const data = parseSubmitData(fields, formTargetClass, formUrl, subject);

    let redirectPolicy;
    let success = true;

    for (const policy of policies) {
        if (policy.executionTarget === "http://example.org/httpRequest") {
            success = (await submitHttpRequest(policy, data)) && success;
        } else if (policy.executionTarget === "http://example.org/redirect") {
            redirectPolicy = policy;
        } else {
            console.warn("Unknown execution target: " + policy.executionTarget);
        }
    }

    if (redirectPolicy && success) {
        // Print the redirect URL as we can't redirect from the terminal
        console.log("Redirecting to: " + redirectPolicy.url);
        // Open the redirect URL in the browser
        await open(redirectPolicy.url);
    }
}

async function parseSubmitPolicy(doc, formUrl) {
    const queryPolicy = `
      PREFIX ex: <http://example.org/>
      PREFIX pol: <https://www.example.org/ns/policy#>
      PREFIX fno: <https://w3id.org/function/ontology#>

      SELECT ?executionTarget ?method ?url ?contentType WHERE {
        ?id pol:policy ?policy .
        ?policy a fno:Execution .
        ?policy fno:executes ?executionTarget .
        ?policy ex:url ?url .
        OPTIONAL { ?policy ex:method ?method } .
        OPTIONAL { ?policy ex:contentType ?contentType } .
      }
      `;
    const bindings = await (
        await engine.queryBindings(queryPolicy, {
            sources: [
                {
                    type: "stringSource",
                    value: doc,
                    mediaType: "text/n3",
                    baseIRI: formUrl.split("#")[0],
                },
            ],
        })
    ).toArray();

    return bindings.map((row) => {
        return {
            executionTarget: row.get("executionTarget").value,
            url: row.get("url").value,
            method: row.get("method")?.value,
            contentType: row.get("contentType")?.value,
        };
    });
}

function parseSubmitData(fields, formTargetClass, generatedBy, subject) {
    let data = `<${subject}> a <${formTargetClass}> .\n`;

    if (generatedBy && subject) {
        data += `<${subject}> a <http://www.w3.org/ns/prov#Entity>; <http://www.w3.org/ns/prov#wasGeneratedBy> <${generatedBy}> .\n`;
    }

    for (const field of fields) {
        for (const value of field.values) {
            if (field.type === "SingleLineTextField" || field.type === "MultiLineTextField") {
                data += `<${subject}> <${field.property}> "${value.value}" .\n`;
            } else if (field.type === "Choice") {
                data += `<${subject}> <${field.property}> <${value.value}> .\n`;
            } else if (field.type === "BooleanField") {
                data += `<${subject}> <${field.property}> ${value.value ? "true" : "false"} .\n`;
            } else if (field.type === "DateField") {
                data += `<${subject}> <${field.property}> "${new Date(
                    value.value
                ).toISOString()}"^^<http://www.w3.org/2001/XMLSchema#date> .\n`;
            } else {
                console.warn("Unknown field type", field.type);
            }
        }
    }
    return data;
}

async function submitHttpRequest(policy, data) {
    const response = await fetch(policy.url, {
        method: policy.method,
        headers: {
            "Content-Type": policy.contentType || "text/n3",
        },
        body: data,
    });

    if (response.ok) {
        console.log("Form submitted successfully via HTTP request.");
        return true;
    } else {
        console.error("HTTP request failed: " + response.status);
        return false;
    }
}

async function getSubjectPossibilities(formTargetClass, n3doc) {
    // Get all existing subjects for the form target class in the data document
    const query = `
      SELECT ?subject WHERE {
        ?subject a <${formTargetClass}> .
      }
      `;
    const bindings = await (
        await engine.queryBindings(query, {
            sources: [
                {
                    type: "stringSource",
                    value: n3doc,
                    mediaType: "text/n3",
                },
            ],
        })
    ).toArray();
    const subjectPossibilities = bindings.map((binding) => binding.get("subject").value);

    // Add random subject
    subjectPossibilities.push(`urn:uuid:${v4()}`);

    // Allow user input
    subjectPossibilities.push("Other");

    return subjectPossibilities;
}

export async function getSubject(formTargetClass, n3doc) {
    // Get suggestions for subject
    const subjectPossibilities = (await getSubjectPossibilities(formTargetClass, n3doc)).map((subject) => {
        return {
            name: subject,
            value: subject,
        };
    });

    // Prompt user for subject
    console.log('\n');
    const questions = [
        {
            type: 'list',
            name: 'subject',
            message: 'Subject URI to use for the data?',
            choices: subjectPossibilities,
        },
    ];
    const action = await inquirer.prompt(questions);
    if (action.subject === 'Other') {
        let subject = '';
        while (!subject) {
            // Allow user to enter a custom subject
            const questions = [
                {
                    type: 'input',
                    name: 'subject',
                    message: 'Subject URI to use for the data?',
                },
            ];
            const otherSubject = await inquirer.prompt(questions);
            subject = await validateSubject(otherSubject.subject);
            if (!subject) {
                console.warn('Please fill in a valid subject.');
            }
        }
        return subject;
    } else {
        return action.subject;
    }
}

async function validateSubject(subject) {
    if (subject.includes(':')) {
        if (!subject.includes('://')) {
            // Do call to prefix.cc to get the full URI
            const [prefix, suffix] = subject.split(':');
            const response = await fetch(`https://prefix.cc/${prefix}.file.json`);
            const json = await response.json();
            const uri = json[prefix];
            if (uri) {
                return uri + suffix;
            } else {
                return null;
            }
        }
    } else {
        return null;
    }
}
