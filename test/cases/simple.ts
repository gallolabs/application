import { runApp, baseConfigSchema } from '../../src/index.js'
import { FromSchema, JSONSchema } from 'json-schema-to-ts'
import { setTimeout } from 'timers/promises'

const configSchema = {
    type: 'object',
    properties: {
        ...baseConfigSchema.properties,
        httpEndpoint: {
            type: 'string'
        }
    },
    required: [...baseConfigSchema.required, 'httpEndpoint'],
    additionalProperties: false
} as const satisfies JSONSchema

runApp<FromSchema<typeof configSchema>>({
    name: 'simpleapp',
    version: '1.0',
    config: {
        schema: configSchema
    },
    consoleUse: 'accepted',
    async run({config, abortSignal}) {
        await setTimeout(3000, undefined, {signal: abortSignal})

        console.log('>>', 'Your request is xxx from', config.httpEndpoint, '<<')
    }
})
