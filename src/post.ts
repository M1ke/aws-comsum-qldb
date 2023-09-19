import {APIGatewayProxyEvent, APIGatewayProxyHandler} from "aws-lambda";
import {QldbDriver, TransactionExecutor} from "amazon-qldb-driver-nodejs";

// This is some env setup
const {LEDGER, TABLE} = process.env
if (!LEDGER) {
    throw 'LEDGER must be defined'
}

// Here's the business logic, where we take data submitted by users and write it
// using a PartiQL query into our ledger.
// We get a transaction ID back, which we could use to query the ledger later,
// or to align with monitoring, audits, our stream or integrity verification

async function insertDocument(txn: TransactionExecutor, data: Record<string, any>): Promise<void> {
    await txn.execute(`INSERT INTO ${TABLE} ?`, data);

    console.log(`Wrote to ledger "${LEDGER}" with transaction ID`, txn.getTransactionId())
}

// QLDB client bootstrap function

async function send(data: Record<string, any>): Promise<void> {
    // Use default settings
    const driver: QldbDriver = new QldbDriver(LEDGER as string);

    await driver.executeLambda(async (txn: TransactionExecutor) => {
        await insertDocument(txn, data);
    });

    driver.close();
}

// The Lambda handler that responds to inbound requests

export const post: APIGatewayProxyHandler = async (event) => {
    console.debug('Request with headers', event.headers)

    if (!isJsonHeaders(event)) {
        return err('You must send a content-type header of application/json')
    }

    const data = dataFromEvent(event)

    if (!data) {
        return err('Request body must be a valid JSON object')
    }

    console.debug('Parsed data is', data)

    try {
        await send(data)
    } catch (e) {
        console.error(e)
        return err(e as string)
    }

    return {
        statusCode: 204,
        body: ''
    }
}

// General HTTP handling utility functions

const err = (message: string, statusCode = 400) =>
    ({
        statusCode,
        body: JSON.stringify({
            message,
        }),
    })

const dataFromEvent = (event: APIGatewayProxyEvent): null | Record<string, any> => {
    try {
        return JSON.parse(event.body ?? '')
    } catch (e) {
        console.error(e, event.body)

        return null
    }
}

const isJsonHeaders = (event: APIGatewayProxyEvent): boolean => {
    const contentType = event.headers['content-type']

    return !!contentType && contentType.indexOf('application/json') > -1
}
