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

Follow these guides to set up your infrastructure (PRs to set this all up with CloudFormation greatly appreciated)

1. Create a ledger: https://docs.aws.amazon.com/qldb/latest/developerguide/getting-started-step-1.html
2. Create a table (using PartiQL): `CREATE TABLE <my table name>`

At this point you can start using QLDB, and the `post` and `digest` methods of our Serverless application can be deployed.

For the stream to work you'll need a Kinesis stream - WARNING, these do have a small daily cost. Running them in provisioned
capacity mode with 2 shards will cost $0.034 per hour, so $0.82 per day and ~$25 per month. Running a few tests however
should cost you less than a dollar.

3. Create a Kinesis stream: https://docs.aws.amazon.com/streams/latest/dev/how-do-i-create-a-stream.html

Now you can find the Kinesis stream ARN and add it to the `.env.dev` file

4. Create a QLDB stream: https://docs.aws.amazon.com/qldb/latest/developerguide/streams.create.html - you'll link this to
   the Kinesis stream you just set up

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
curl -v -X POST -H 'content-type:application/json' -d '{"email":"quantumania@comsum.co.uk"}' "https://<blah blah>.execute-api.eu-west-1.amazonaws.com/data"
```

If you now run `sls logs --stage=dev --function=post` you should see two logs: a debug log with headers, and a confirmation of the
parsed JSON data, as well as a transaction ID, which will be useful later if we want to correlate this insert with other
actions on the ledger.

We can also examine more detail on our stream, such as learning about the transaction identifiers that represent the
actions taken on the ledger `sls logs --stage=dev --function=stream`

If we open the QLDB console in a browser and use the "PartiQL editor" on the left hand sidebar, we can run a simple:

```
select * from <our table name>
```

And we will see the data sent to the journal via our CURL request. As an interesting departure from SQL we can also run
a query like:

```
select * from <our table name> by id
```

Which will include the document ID. In an even stranger query we can query a pseudo-table whose name looks like:
`_ql_committed_<our table name>` so if our table is called `example` this table would be `_ql_committed_example` and
we could query it as follows with the ID we got from the query above, or from our stream output (the record ID, not
the transaction ID from the insert query)

```
SELECT metadata.id, blockAddress FROM _ql_committed_example where metadata.id='ATP7XiU7VQb8CzWJ63mQg5';
```

This would give us a block address, which we can use to _validate_ this record for consistency with the ledger.

To validate we also need a digest: a record of a given state the ledger has been in the past. We can pull a digest
using: `sls invoke --stage=dev --function=digest` and head to the Verification page on the QLDB console sidebar to input
the digest details (second part of the form) and the metadata ID and block address (first part of the form). The same 
record-level data is also shown for verification in the stream logs.
