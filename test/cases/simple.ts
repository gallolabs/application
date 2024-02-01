import { runApp, baseConfigSchema } from '../../src/index.js'
import { FromSchema, JSONSchema } from 'json-schema-to-ts'
import { setTimeout } from 'timers/promises'

const configSchema = {
    ...baseConfigSchema,
    properties: {
        ...baseConfigSchema.properties,
        httpEndpoint: {
            type: 'string'
        },
        timeout: {
            type: 'number',
            default: 5000
        },
        query: {
            type: 'string'
        },
        notMandatory: {type: 'string'}
    },
    required: ['httpEndpoint', 'timeout', ...baseConfigSchema.required]
} as const satisfies JSONSchema

type Config = FromSchema<typeof configSchema>

runApp<Config>({
    name: 'simpleapp',
    version: '1.0',
    config: {
        schema: configSchema
    },
    consoleUse: 'accepted',
    async run({config, abortSignal}) {
        await setTimeout(3000)

        if (abortSignal.aborted) {
            throw abortSignal.reason
        }

        const response = 'called ' + config.httpEndpoint

        console.log('>>', 'Your request is', response, '<<')
    }
})
