# AWS Comsum 23 - Quantumania

This library provides an example API for loading arbitrary JSON payloads into QLDB. It exposes a public endpoint
that will let anyone with the API Gateway URL post data to your QLDB ledger, so isn't recommended for production.

It also contains functions to find your latest digest (this can be run using serverless invoke or awscli lambda-invoke)
and most usefully a stream function which runs a Lambda from a Kinesis Stream.

In order to use this you'll need to copy `env.sample` to `.env.<your stage name>`  and then fill in the
`LEDGER`, `TABLE` and `STREAM_ARN` methods. The region is set to `eu-west-1` which seems a sensible default but feel
free to change this - ideally your Ledger and streams are in the same region, I haven't tested if any of these work
across regions.

For the rest of the guide we'll assume the stage is called `dev`, so the env file will be `.env.dev`

## Infrastructure

Follow these guides to set up your infrastructure (PRs to set this all up with CloudFormation greatly appreciated)

1. Create a ledger: https://docs.aws.amazon.com/qldb/latest/developerguide/getting-started-step-1.html
2. Create a table (using PartiQL): `CREATE TABLE <my table name>`

At this point you can start using QLDB, and the `post` and `digest` methods of our Serverless application can be deployed.
Also for the rest of this guide we'll assume `<my table name>` was `example`.

For the stream to work you'll need a Kinesis stream - WARNING, these do have a small daily cost. Running them in provisioned
capacity mode with 2 shards will cost $0.034 per hour, so $0.82 per day and ~$25 per month. Running a few tests however
should cost you less than a dollar.

3. Create a Kinesis stream: https://docs.aws.amazon.com/streams/latest/dev/how-do-i-create-a-stream.html

Now you can find the Kinesis stream ARN and add it to the `.env.dev` file

4. Create a QLDB stream: https://docs.aws.amazon.com/qldb/latest/developerguide/streams.create.html - you'll link this to
   the Kinesis stream you just set up

## Serverless deploy

Now we're ready to deploy the application using the `serverless` framework. If you don't have it installed go ahead
and run `npm i -g serverless`

To deploy run `sls deploy --stage=dev` with credentials that have access to create S3 buckets,
Lambdas, IAM roles, and read some account data.

The output of your deploy will look something like:

```
✔ Service deployed to stack comsum-qldb-dev (57s)

endpoint: POST - https://<some alpha numeric code>.execute-api.<region>.amazonaws.com/data
functions:
  post: comsum-qldb-dev-post (7.5 MB)
  digest: comsum-qldb-dev-digest (7.5 MB)
  stream: comsum-qldb-dev-stream (7.5 MB)
```

You can now fire a request at that URL with any arbitrary data you'd like such as:

```
curl -v -X POST -H 'content-type:application/json' -d '{"email":"quantumania@comsum.co.uk"}' "https://<some alpha numeric code>.execute-api.eu-west-1.amazonaws.com/data"
```

If you now run `sls logs --stage=dev --function=post` you should see two logs: a debug log with headers, and a confirmation of the
parsed JSON data, as well as a transaction ID, which will be useful later if we want to correlate this insert with other
actions on the ledger.

We can also examine more detail on our stream, such as learning about the transaction identifiers that represent the
actions taken on the ledger `sls logs --stage=dev --function=stream`

## History

First we can make sure there's a known data item in our table. Let's do:

```
INSERT INTO example
{
	'user_id' : 1,
	'name' : 'comsum',
	'email' : 'qldb@comsum.co.uk',
	'address' : {
	  'city' : 'Manchester'
	},
   'hobbies': ['aws','conferences']
}
```

Now we check it's there, and get its newly assigned database ID (we need `user_id` as an index for this):

```
CREATE INDEX ON example(user_id);

SELECT * FROM example BY id WHERE user_id=1;
```

We now know the ID of this document which will be useful later. We're also going to do something a bit odd here 
which is to invoke one of our serverless functions:

```
aws-vault exec m1ke-admin -- sls invoke --function digest
```

We'll just copy that result somewhere safe - trust me it'll be useful later.

Let's update it:

```
UPDATE example SET address.city = 'Liverpool' WHERE user_id=1;
```

And a different type of update

```
FROM example AS e WHERE user_id=1
INSERT INTO e.hobbies VALUE 'sql';
```

Now we delete the record:

```
DELETE FROM example WHERE user_id=1;
```

Then we query our history (note the backticks on the timestamps, and that they are in UTC):

```
SELECT * FROM history(example, `2023-09-28T11:30:00Z`, `2023-09-28T11:35:00Z`) AS h
WHERE h.metadata.id = '<document id>';
```

## Verification

With the result of the previous query (history) we can verify our original document insert. If we choose the "Ion text"
view we're presented with a list of documents and the first one will look like:

```
{ 
  blockAddress: { 
    strandId: "<alphanumeric>",
    sequenceNo: <int>
  },
  hash: {{<base 64>}},
  data: { 
    <our object data from the insert
  },
  metadata: { 
    id: "<alphanumeric>",
    version: 0,
    txTime: <timestamp in UTC>,
    txId: "<alphanumeric>"
  }
},
```

If we visit the "Verification" link in the QLDB console sidebar we can enter some of the data we've gathered so far.

1. Select our ledger in the "Ledger" dropdown
2. Enter the document ID we've been using to check history
3. Enter the content of the `blockAddress` key above (e.g. `{strandId:"AbC123",sequenceNo: 123}`)
4. In the "specify the digest" block we can look at the `invoke --function digest` output we ran earlier.
5. The Digest is recorded first and will look like a base64 string (not the hash in the history output, but it'll look
similar)
6. Then the Digest tip address, also from the invoke output, and it'll be an identical format to the block address we
used above. One thing to note is that the `sequenceNo` field in the Digest tip must be greater or equal to the
`sequenceNo` used in the Block address.
7. Click verify or respond to any errors on the page.

The verification result shows cryptographic proofs and also shows the digest history of the revision.

If you wanted at this point you could take this data and work the hashes out for yourself - as hashes are one-way, you
know that if you're able to carry out the algorithm and generate the correct hashes, the data integrity is valid.

If you happen not to have the date range to query document history, and the document isn't deleted, another way to find
a Block address to carry out verification is using the ledger commit database. This appears as a pseudo-table whose name
looks like:

`_ql_committed_<our table name>`

So if our table is called `example` this table would be `_ql_committed_example` and we could query it as follows with
the document ID:

```
SELECT metadata.id, blockAddress FROM _ql_committed_example where metadata.id='<document id>';
```

The `blockAddress` here is the same as we get from history.

## Cheat sheet

A few handy queries. To drop an index:

```
DROP INDEX "<index id>" ON table_name WITH (purge = true)
```

To find the `<index id>` to use in the above, query the information schema:

```
SELECT * FROM information_schema.user_tables WHERE name = '<table name>'
```

AWS QLDB PartiQL reference: https://docs.aws.amazon.com/qldb/latest/developerguide/ql-reference.html
