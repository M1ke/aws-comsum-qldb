import * as deagg from 'aws-kinesis-agg';
import * as ion from 'ion-js';
import {KinesisStreamHandler, KinesisStreamRecordPayload} from "aws-lambda";

// This is some env setup
const {LEDGER} = process.env
if (!LEDGER) {
    throw 'LEDGER must be defined'
}

// Some types we'll use

type DeaggRecord = { data: string }

const RecordRevisionDetails = 'REVISION_DETAILS'
const RecordBlockSummary = 'BLOCK_SUMMARY'

interface QldbRecord {
    recordType: string
}
interface QldbRevisionDetails extends QldbRecord {
    recordType: typeof RecordRevisionDetails
    tableInfo: {
        tableName: string
        tableId: string
    }
    revision: {
        blockAddress: {
            strandId: string
            sequenceNo: 44,
        }
        hash: string
        data: Record<string, any>
        metadata: {
            id: string
            version: number
            txTime: string // In date format YYYY-MM-DDTHH:mm:ss.msZ
            txId: string
        }
    }
}
interface QldbBlockSummary extends QldbRecord {
    recordType: typeof RecordBlockSummary
    transactionId: string
    blockHash: string,
    transactionInfo: {
        statements: {statement: string, startTime: string, statementDigest: string}[],
        documents: Record<string, { tableName: string, tableId: string, statements: []}>
    }
    revisionSummaries: {
      hash: string
      documentId: string
    }[]
}

const isRevisionDetails = (qldbRecord: QldbRecord): qldbRecord is QldbRevisionDetails => {
    return qldbRecord.recordType===RecordRevisionDetails
}

const isBlockSummary = (qldbRecord: QldbRecord): qldbRecord is QldbBlockSummary => {
    return qldbRecord.recordType===RecordBlockSummary
}

// This is the business logic where we have some QLDB data and we can do stuff with it

const handleQldbRevisionDetails = (details: QldbRevisionDetails) => {
    const { revision: { metadata: { id }, data , blockAddress: { strandId, sequenceNo} }} = details

    console.log('A record was inserted with ID', id)
    console.log('The record had content: ',  data)

    console.log(`You can verify this record using Block address: {strandId: "${strandId}", sequenceNo: ${sequenceNo}}`)
};

const handleQldbBlockSummary = (summary: QldbBlockSummary) => {
    const { transactionInfo: { documents, statements} } = summary

    console.log('The following statements were run', statements)
    console.log('The following documents were modified', documents)
};

const handleQldbData = (qldbRecord: QldbRecord): void => {

    // This is where we'd do stuff like write an aggregate to DynamoDB, or write to multiple tables
    // in SQL (depending which object type we were receiving, which is up to us how we structure the
    // document format in QLDB)

    // If we're deciding to write to multiple places, it's actually better for us to have one stream
    // listener per action, assuming the actions are independent of each other. If we wanted to catch failures
    // we could instead pipe data into an SQS queue, and then run the actual processing from that

    if (isRevisionDetails(qldbRecord)){
        return handleQldbRevisionDetails(qldbRecord)
    }

    if (isBlockSummary(qldbRecord)){
        return handleQldbBlockSummary(qldbRecord)
    }

    console.log('Got QLDB stream record that didn\'t match expected type', qldbRecord)
}

// This is our Lambda handler that kicks everything off
export const read: KinesisStreamHandler = async (event) => {
    await Promise.all(
        event.Records.map(async (element) => {
            console.log('Kinesis sequence number', element.kinesis.sequenceNumber);
            const records = await promiseDeaggregate(element.kinesis);
            await processRecords(records);
        })
    );
};

// This next block is just utils to handle the way we receive the data from Kinesis, don't read much into it
// It was mostly sourced from these references:
//   https://github.com/t1agob/eventsourcing-qldb/blob/master/backend/src/DynamoProcessor/handler.ts
//   https://dev.to/aws-heroes/real-time-streaming-for-amazon-qldb-3c3c

const promiseDeaggregate = async (record: KinesisStreamRecordPayload): Promise<DeaggRecord[]> => (
    new Promise((resolve, reject) => {
        deagg.deaggregateSync(record, true, (err, responseObject) => {
            if (err || !responseObject) {
                return reject(err);
            }

            return resolve(responseObject);
        })
    }));

const processRecords = async (records: DeaggRecord[]) => {
    await Promise.all(
        records.map(async (record, n) => {
            const {data} = record
            const payload = Buffer.from(data, 'base64');

            const ionRecord = ion.load(payload);
            if (!ionRecord) {
                console.log('Received data was not loaded as ion', n, data)
                return;
            }

            const qldbData = makeQldbType(ionRecord)

            handleQldbData(qldbData)
        }),
    );
};

const makeQldbType = (ionRecord: ion.dom.Value): QldbRecord => {
    // There may be a neater way to do this but it seems to work
    const { recordType, payload } = JSON.parse(JSON.stringify(ionRecord));
    return { recordType, ...payload }
}
