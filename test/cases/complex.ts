import { setInterval } from 'timers/promises'
import { runApp, baseConfigSchema } from '../../src/index.js'
import { FromSchema, JSONSchema } from 'json-schema-to-ts'

const configSchema = {
    type: 'object',
    properties: {
        ...baseConfigSchema.properties
    },
    required: [...baseConfigSchema.required],
    additionalProperties: false
} as const satisfies JSONSchema

runApp<FromSchema<typeof configSchema>>({
    name: 'complexapp',
    version: '1.0',
    config: {
        schema: configSchema
    },
    consoleUse: 'accepted',
    async run({abortSignal, metrics}) {
        const tickCounter = metrics.createCounter({
            help: 'Number of called interval',
            name: 'called_interval'
        })

        metrics.createGauge({
            help: 'Random value',
            name: 'random',
            collect() {
                this.set(Math.round(Math.random() * 10000))
            }
        })

        const httpInputHistogram = metrics.createHistogram({
            help: 'Input Http Requests',
            name: 'input_http',
            buckets: [40, 100, 500]
        })

        for await (const _ of setInterval(1000, undefined, { signal: abortSignal})) {
            const elapsedTime = Math.round(Math.random() * 750)
            tickCounter.inc()
            httpInputHistogram.observe(elapsedTime)
            //remoteEE.emit('tick', { elapsedTime })
        }
    }
})
