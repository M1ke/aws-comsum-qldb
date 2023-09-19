import {Handler} from "aws-lambda";
import {QLDBClient, GetDigestCommand, GetDigestCommandOutput} from "@aws-sdk/client-qldb";

const qldbClient = new QLDBClient();

const {LEDGER} = process.env
if (!LEDGER) {
    throw 'LEDGER must be defined'
}

type Digest = {
    digest: string
    tipAddress: string
}

const uint8ArrayToString = (arr: Uint8Array | undefined): string => {
    if (!arr) {
        throw 'The digest received was blank'
    }

    return Array.from(arr)
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('');
}

const uint8ArrayToBase64 = (arr: Uint8Array | undefined): string => {
    if (!arr) {
        throw 'The digest received was blank'
    }

    return Buffer.from(arr).toString('base64')
}

const digestResponseToObject = (response: GetDigestCommandOutput): Digest => {
    const digest = uint8ArrayToBase64(response.Digest)

    const tipAddress = response.DigestTipAddress?.IonText
    if (!tipAddress) {
        throw 'The tip address was not present'
    }

    return {
        digest,
        tipAddress
    }
}

async function getQldbDigest(): Promise<Digest> {
    const command = new GetDigestCommand({Name: LEDGER});

    try {
        const response = await qldbClient.send(command);

        console.log(response)

        return digestResponseToObject(response)
    } catch (error) {
        console.error("Error retrieving QLDB digest:", error);
        throw error;
    }
}

export const get: Handler = async (event, context) => {
    console.log('Lambda is running with event', event)

    const digest = await getQldbDigest()
        .catch((error) => {
            console.error("Error:", error);
        });

    if (!digest) {
        return 'Something went wrong and no digest was produced, check the logs for more info'
    }

    return "Put this into the 'Digest' box: " + digest.digest + " and this into 'Digest tip address' (you may need to remove slashes if added by your CLI tool): " + digest.tipAddress
};
