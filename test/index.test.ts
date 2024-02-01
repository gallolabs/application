import { ExitCodes } from '../src/index.js'
import assert from 'assert'
import { spawn } from 'child_process'
import { once } from 'events'
import { setTimeout } from 'timers/promises'

describe('Application', () => {

    it('simple', async() => {
        const proc = spawn(
            'node',
            ['dist/test/cases/simple.js'],
            { stdio: 'inherit', env: {
                simpleapp_httpEndpoint: 'https://jsonplaceholder.typicode.com/todos/1',
                simpleapp_query: 'title'
            } }
        )

        const [exitCode] = await once(proc, 'exit')

        assert.strictEqual(exitCode, 0)
    }).timeout(5000)

    it('simple abort', async() => {
        const proc = spawn(
            'node',
            ['dist/test/cases/simple.js'],
            { stdio: 'inherit', env: {
                simpleapp_httpEndpoint: 'http://99.99.99.99',
                simpleapp_log_level: 'debug'
            } }
        )

        await setTimeout(3000)
        proc.kill('SIGINT')

        const [exitCode] = await once(proc, 'exit')

        assert.strictEqual(exitCode, ExitCodes.SIGINT)
    }).timeout(10000)

})

