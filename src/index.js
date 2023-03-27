const { QueryEngine } = require('@comunica/query-sparql');

const engine = new QueryEngine();

async function loadContentOfUrl(url) {
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

async function parseForm(n3form, formUrl) {
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

async function queryDataForField(data, field, doc) {
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

module.exports = {
    loadContentOfUrl,
    parseForm,
    queryDataForField,
};
