//
// Copyright 2025 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only
//

package db

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/aws/ratelimit"
	"github.com/aws/aws-sdk-go-v2/aws/retry"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/feature/dynamodb/attributevalue"
	"github.com/aws/aws-sdk-go-v2/feature/dynamodb/expression"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"

	metrics "github.com/hashicorp/go-metrics"
)

const (
	maxBatchKeys                = 90
	maxDynamoBatchSize          = 100
	keyLabel                    = "k"
	valueLabel                  = "v"
	attrCanonicallyDiscoverable = "C"
	attrUnidentifiedAccessKey   = "UAK"
	attrAci                     = "U"
)

type dynamoReadReq struct {
	keys       []string
	data       map[string][]byte
	resp       chan error
	consistent bool
}

// ddbConn is a wrapper around a base DynamoDB connection that handles batching
// writes between commits transparently.
type ddbConn struct {
	conn     *dynamodb.Client
	table    string
	ch       chan dynamoReadReq
	readonly bool
	// If readonly is true, batch will by definition be nil (thus: empty).
	// Since a writable ddbConn doesn't allow concurrent reads/writes,
	// and readonly ddbConn always has a nil map, there is no need to lock this
	// against concurrent access.
	batch map[string][]byte
}

func newDDBConn(conn *dynamodb.Client, table string, parallel int) *ddbConn {
	batches := make(chan []dynamoReadReq)
	out := &ddbConn{
		conn:     conn,
		table:    table,
		ch:       make(chan dynamoReadReq, 100),
		readonly: false,
		batch:    make(map[string][]byte),
	}

	// Start a number of worker goroutines, configured by `parallel`, that will
	// take batches of read requests and send them to Dynamo. Build batches in a
	// dedicated goroutine, rather than have each worker goroutine build it's
	// own batches, to ensure we have the largest batches possible.
	//
	// Manual batching like this is required in the first place because Dynamo
	// doesn't support HTTP/2 -- firing off a bunch of concurrent requests
	// results in a large number of distinct connections being made, and the
	// overhead of all those connections degrades performance.
	go func() {
		for {
			batches <- out.receiveBatch()
		}
	}()
	for i := 0; i < parallel; i++ {
		go func() {
			for {
				reqs := <-batches
				err := out.handleBatch(reqs)
				for _, req := range reqs {
					req.resp <- err
				}
			}
		}()
	}

	return out
}

// receiveBatch takes a series of read requests off of the queue, trying to get
// a batch of maxBatchKeys keys.
//
// The max batch size to Dynamo is 100 keys, but once we take a request off of
// the queue we have to handle it. Aims for maxBatchKeys to avoid overcommitting.
func (c *ddbConn) receiveBatch() []dynamoReadReq {
	var out []dynamoReadReq
	total := 0

	req := <-c.ch
	out = append(out, req)
	total += len(req.keys)

loop:
	for total < maxBatchKeys {
		select {
		case req := <-c.ch:
			out = append(out, req)
			total += len(req.keys)
		default:
			break loop
		}
	}

	return out
}

// handleBatch processes a batch of read requests and writes the fetched data into a receiving map on each request.
func (c *ddbConn) handleBatch(reqs []dynamoReadReq) error {
	// Build an index from the keys to lookup, to the requests for that key.
	keyIndex := make(map[string][]int)

	for i, req := range reqs {
		for _, key := range req.keys {
			keyIndex[key] = append(keyIndex[key], i)
		}
	}

	// Build a slice of keys to batch get
	keys := make([]string, 0, len(keyIndex))
	for key := range keyIndex {
		keys = append(keys, key)
	}

	// Fetch keys in batch
	data := make(map[string][]byte, len(keys))
	err := c.batchGet(keys, data)
	if err != nil {
		return err
	}
	metrics.IncrCounter([]string{"dynamodb", "strongly_consistent_read"}, 1)

	// Move the fetched data into the receiving maps.
	for key, val := range data {
		for i, j := range keyIndex[key] {
			if i == 0 {
				reqs[j].data[key] = val
			} else {
				reqs[j].data[key] = dup(val)
			}
		}
	}

	metrics.AddSample([]string{"dynamodb", "batch_size"}, float32(len(keys)))
	return nil
}

// batchGet fetches a batch of keys from DynamoDB and writes the data into the provided map.
func (c *ddbConn) batchGet(keys []string, res map[string][]byte) error {
	kvs := make([]map[string]types.AttributeValue, len(keys))
	for i, key := range keys {
		kvs[i] = map[string]types.AttributeValue{
			keyLabel: &types.AttributeValueMemberS{Value: key},
		}
	}
	consistent := true
	for len(kvs) > 0 {
		var now []map[string]types.AttributeValue
		if len(kvs) > maxDynamoBatchSize {
			now, kvs = kvs[:maxDynamoBatchSize], kvs[maxDynamoBatchSize:]
		} else {
			now, kvs = kvs, nil
		}
		out, err := c.conn.BatchGetItem(context.Background(), &dynamodb.BatchGetItemInput{
			RequestItems: map[string]types.KeysAndAttributes{c.table: {
				Keys:           now,
				ConsistentRead: &consistent,
			}},
		})
		if err != nil {
			return err
		}
		unprocessed := out.UnprocessedKeys[c.table].Keys
		if len(unprocessed) > 0 {
			kvs = append(kvs, unprocessed...)
		}

		consumed := len(now) - len(unprocessed)
		metrics.IncrCounterWithLabels(
			[]string{"dynamodb", "read_capacity"},
			float32(consumed),
			[]metrics.Label{{Name: "consistent", Value: fmt.Sprint(consistent)}},
		)

		for _, data := range out.Responses[c.table] {
			key, ok := data[keyLabel].(*types.AttributeValueMemberS)
			if !ok {
				return fmt.Errorf("malformed database entry")
			}
			value, ok := data[valueLabel].(*types.AttributeValueMemberB)
			if !ok {
				return fmt.Errorf("malformed database entry")
			}
			res[key.Value] = value.Value
		}
	}

	return nil
}

// Get fetches a single key from DynamoDB.
func (c *ddbConn) Get(key string) ([]byte, error) {
	keySet := [1]string{key}
	out, err := c.BatchGet(keySet[:])
	if err != nil {
		return nil, err
	}
	return out[key], nil
}

// BatchGet fetches a batch of keys from DynamoDB.
func (c *ddbConn) BatchGet(keys []string) (map[string][]byte, error) {
	data := map[string][]byte{}
	var uncachedKeys []string
	// Move cached keys directly into the output data map.
	for _, key := range keys {
		if value, ok := c.batch[key]; ok {
			data[key] = dup(value)
		} else {
			uncachedKeys = append(uncachedKeys, key)
		}
	}

	// Fetch remaining keys from the database.
	start := time.Now()
	consistent := true
	req := dynamoReadReq{
		keys:       uncachedKeys,
		data:       data,
		resp:       make(chan error, 1),
		consistent: consistent,
	}
	c.ch <- req
	if err := <-req.resp; err != nil {
		return nil, err
	}

	metrics.MeasureSinceWithLabels([]string{"dynamodb", "get_duration"}, start, []metrics.Label{
		{Name: "readonly", Value: fmt.Sprint(c.readonly)},
		{Name: "consistent", Value: fmt.Sprint(consistent)},
		{Name: "singular", Value: fmt.Sprint(len(keys) == 1)},
	})
	return data, nil
}

func (c *ddbConn) Put(key string, value []byte) {
	if c.readonly {
		panic("connection is readonly")
	}
	c.batch[key] = dup(value)
}

// Commit commits all outstanding writes to DynamoDB.
// The tree head ("root") data write is deferred until all other writes have succeeded.
func (c *ddbConn) Commit() error {
	if c.readonly {
		panic("connection is readonly")
	}
	start := time.Now()
	iters := 0

	defer func() { c.batch = map[string][]byte{} }()

	// Build the initial set of write requests to make.
	reqs := make([]types.WriteRequest, 0)
	for key, value := range c.batch {
		if key == "root" {
			continue
		}
		reqs = append(reqs, types.WriteRequest{PutRequest: &types.PutRequest{
			Item: map[string]types.AttributeValue{
				keyLabel:   &types.AttributeValueMemberS{Value: key},
				valueLabel: &types.AttributeValueMemberB{Value: value},
			},
		}})
	}

	// Submit requests to database in batches, looping until all writes have propagated to the database.
	for len(reqs) > 0 {
		iters++

		var err error
		reqs, err = c.batchWriteParallel(reqs)
		if err != nil {
			return err
		}
	}

	// Write the new root to the database last.
	if value, ok := c.batch["root"]; ok {
		_, err := c.conn.PutItem(context.Background(), &dynamodb.PutItemInput{
			TableName: &c.table,
			Item: map[string]types.AttributeValue{
				keyLabel:   &types.AttributeValueMemberS{Value: "root"},
				valueLabel: &types.AttributeValueMemberB{Value: value},
			},
		})
		if err != nil {
			return err
		}
		metrics.IncrCounter([]string{"dynamodb", "write_capacity"}, 1)
	}
	metrics.MeasureSinceWithLabels(
		[]string{"dynamodb", "commit_duration"},
		start,
		[]metrics.Label{{Name: "iters", Value: fmt.Sprint(iters)}},
	)
	return nil
}

// batchWriteParallel splits writes across multiple goroutines and returns a list of unfulfilled write requests.
func (c *ddbConn) batchWriteParallel(reqs []types.WriteRequest) ([]types.WriteRequest, error) {
	type dynamoWriteRes struct {
		unprocessed []types.WriteRequest
		err         error
	}
	ch := make(chan dynamoWriteRes)

	goroutines := 0
	for len(reqs) > 0 {
		var now []types.WriteRequest
		if len(reqs) > 25 {
			now, reqs = reqs[:25], reqs[25:]
		} else {
			now, reqs = reqs, nil
		}
		go func() {
			unprocessed, err := c.batchWrite(now)
			ch <- dynamoWriteRes{unprocessed, err}
		}()
		goroutines++
	}

	results := make([]dynamoWriteRes, goroutines)
	for i := 0; i < goroutines; i++ {
		results[i] = <-ch
	}
	var unprocessed []types.WriteRequest
	for _, res := range results {
		if res.err != nil {
			return nil, res.err
		}
		unprocessed = append(unprocessed, res.unprocessed...)
	}
	return unprocessed, nil
}

// batchWrite makes a single batch write request to DynamoDB and returns any unfulfilled write requests.
func (c *ddbConn) batchWrite(reqs []types.WriteRequest) ([]types.WriteRequest, error) {
	out, err := c.conn.BatchWriteItem(context.Background(), &dynamodb.BatchWriteItemInput{
		RequestItems: map[string][]types.WriteRequest{c.table: reqs},
	})
	if err != nil {
		return nil, err
	}
	unprocessed := out.UnprocessedItems[c.table]
	metrics.IncrCounter([]string{"dynamodb", "write_capacity"}, float32(len(reqs)-len(unprocessed)))
	return unprocessed, nil
}

// Clone returns a read-only copy of the DynamoDB connection.
func (c *ddbConn) Clone() *ddbConn {
	if len(c.batch) > 0 {
		panic("no outstanding writes are allowed in a cloning ddbConn")
	}
	return &ddbConn{
		conn:     c.conn,
		table:    c.table,
		ch:       c.ch,
		readonly: true,
		batch:    nil,
	}
}

// ddbTransparencyStore implements the TransparencyStore interface over a
// DynamoDB connection.
type ddbTransparencyStore struct {
	conn *ddbConn
}

var (
	adaptiveRetryer = retry.NewAdaptiveMode(func(opts *retry.AdaptiveModeOptions) {
		opts.StandardOptions = append(opts.StandardOptions, func(opts *retry.StandardOptions) {
			// Start with a larger token bucket and reduce the cost for non-timeout errors.
			// The default is 500 and 5, respectively.
			// https://pkg.go.dev/github.com/aws/aws-sdk-go-v2/aws/retry#StandardOptions
			opts.RateLimiter = ratelimit.NewTokenRateLimit(1000)
			opts.RetryCost = 1
			opts.MaxAttempts = 500
			opts.MaxBackoff = time.Minute * 30
		})
	})
)

func NewDynamoDBTransparencyStore(table string, parallel int) (TransparencyStore, error) {
	cfg, err := config.LoadDefaultConfig(context.Background(), config.WithRetryer(func() aws.Retryer {
		return adaptiveRetryer
	}))
	if err != nil {
		return nil, err
	}
	return &ddbTransparencyStore{newDDBConn(dynamodb.NewFromConfig(cfg), table, parallel)}, nil
}

// Clone returns a read-only DynamoDB connection for transparency tree data.
func (ddb *ddbTransparencyStore) Clone() TransparencyStore {
	return &ddbTransparencyStore{ddb.conn.Clone()}
}

// GetHead fetches and deserializes the latest tree head data from DynamoDB.
func (ddb *ddbTransparencyStore) GetHead() (*TransparencyTreeHead, map[string]*AuditorTreeHead, error) {
	latest, err := ddb.conn.Get("root")
	if err != nil {
		return nil, nil, err
	} else if latest == nil {
		return &TransparencyTreeHead{}, make(map[string]*AuditorTreeHead), nil
	}
	return deserializeStoredTreeHead(latest)
}

// Get gets the requested transparency tree data.
func (ddb *ddbTransparencyStore) Get(key uint64) ([]byte, error) {
	return ddb.conn.Get("t" + fmt.Sprint(key))
}

// Put adds the specified transparency tree data to the map of outstanding writes.
func (ddb *ddbTransparencyStore) Put(key uint64, data []byte) {
	ddb.conn.Put("t"+fmt.Sprint(key), data)
}

// LogStore returns a DynamoDB connection for log tree data.
func (ddb *ddbTransparencyStore) LogStore() LogStore {
	return &ddbLogStore{ddb.conn}
}

// PrefixStore returns a DynamoDB connection for prefix tree data.
func (ddb *ddbTransparencyStore) PrefixStore() PrefixStore {
	return &ddbPrefixStore{ddb.conn}
}

// StreamStore returns a DynamoDB connection for stream data.
func (ddb *ddbTransparencyStore) StreamStore() StreamStore {
	return &ddbStreamStore{ddb.conn.conn, ddb.conn.table}
}

// Commit takes a transparency tree head and auditor tree head as input and commits all outstanding writes
// to DynamoDB.
func (ddb *ddbTransparencyStore) Commit(head *TransparencyTreeHead, auditors map[string]*AuditorTreeHead) error {
	raw, err := json.Marshal(&storedTreeHead{head, auditors})
	if err != nil {
		panic(err)
	}
	ddb.conn.Put("root", raw)
	return ddb.conn.Commit()
}

// ddbLogStore implements the LogStore interface over DynamoDB.
type ddbLogStore struct {
	conn *ddbConn
}

// BatchGet fetches the requested log tree data from DynamoDB.
func (ls *ddbLogStore) BatchGet(keys []uint64) (map[uint64][]byte, error) {
	sKeys := make([]string, len(keys))
	for i, key := range keys {
		sKeys[i] = "l" + fmt.Sprint(key)
	}
	data, err := ls.conn.BatchGet(sKeys)
	if err != nil {
		return nil, err
	}
	out := make(map[uint64][]byte)
	for i, key := range keys {
		if val, ok := data[sKeys[i]]; ok {
			out[key] = val
		}
	}
	return out, nil
}

// BatchPut adds the specified log tree data to the map of outstanding writes.
func (ls *ddbLogStore) BatchPut(data map[uint64][]byte) {
	for key, value := range data {
		ls.conn.Put("l"+fmt.Sprint(key), value)
	}
}

// ddbPrefixStore implements the PrefixStore interface over DynamoDB.
type ddbPrefixStore struct {
	conn *ddbConn
}

// BatchGet fetches the requested prefix tree data from DynamoDB.
func (ps *ddbPrefixStore) BatchGet(keys []uint64) (map[uint64][]byte, error) {
	sKeys := make([]string, len(keys))
	for i, key := range keys {
		sKeys[i] = "p" + fmt.Sprint(key)
	}
	data, err := ps.conn.BatchGet(sKeys)
	if err != nil {
		return nil, err
	}
	out := make(map[uint64][]byte)
	for i, key := range keys {
		if val, ok := data[sKeys[i]]; ok {
			out[key] = val
		}
	}
	return out, nil
}

// GetCached fetches the requested prefix tree data from the map of outstanding writes
// and returns nil if the key does not exist.
func (ps *ddbPrefixStore) GetCached(key uint64) []byte {
	if value, ok := ps.conn.batch["p"+fmt.Sprint(key)]; ok {
		return dup(value)
	}
	return nil
}

// Put adds the specified prefix tree data to the map of outstanding writes.
func (ps *ddbPrefixStore) Put(key uint64, data []byte) {
	ps.conn.Put("p"+fmt.Sprint(key), data)
}

// ddbStreamStore implements the StreamStore interface over DynamoDB.
type ddbStreamStore struct {
	conn  *dynamodb.Client
	table string
}

// key returns a map containing a primary key for the specified shard.
func (ss *ddbStreamStore) key(streamName, shardID string) map[string]types.AttributeValue {
	return map[string]types.AttributeValue{
		keyLabel: &types.AttributeValueMemberS{
			Value: fmt.Sprintf("stream=%v,shardID=%v", streamName, shardID),
		},
	}
}

// GetCheckpoint returns the last sequence number stored for the specified shard, which allows the stream consumer
// to pick up from where it left off previously in the Kinesis stream.
func (ss *ddbStreamStore) GetCheckpoint(streamName, shardID string) (string, error) {
	consistent := true
	out, err := ss.conn.GetItem(context.Background(), &dynamodb.GetItemInput{
		Key:            ss.key(streamName, shardID),
		TableName:      &ss.table,
		ConsistentRead: &consistent,
	})
	if err != nil {
		return "", err
	}
	metrics.IncrCounterWithLabels(
		[]string{"dynamodb", "read_capacity"},
		1,
		[]metrics.Label{{Name: "consistent", Value: fmt.Sprint(consistent)}},
	)

	if len(out.Item) == 0 {
		return "", nil
	}
	value, ok := out.Item[valueLabel].(*types.AttributeValueMemberB)
	if !ok {
		return "", fmt.Errorf("malformed database entry")
	}
	return string(value.Value), nil
}

// SetCheckpoint stores a sequence number for the specified shard.
func (ss *ddbStreamStore) SetCheckpoint(streamName, shardID string, sequenceNumber string) error {
	item := ss.key(streamName, shardID)
	item[valueLabel] = &types.AttributeValueMemberB{Value: []byte(sequenceNumber)}

	_, err := ss.conn.PutItem(context.Background(), &dynamodb.PutItemInput{
		TableName: &ss.table,
		Item:      item,
	})
	if err != nil {
		return err
	}
	metrics.IncrCounter([]string{"dynamodb", "write_capacity"}, 1)

	return nil
}

// ddbAccount fetches account info from DynamoDB
type ddbAccount struct {
	conn      *dynamodb.Client
	accountDb string
}

func NewAccountDB(accountDb string) (AccountDB, error) {
	cfg, err := config.LoadDefaultConfig(context.Background(), config.WithRetryer(func() aws.Retryer {
		return adaptiveRetryer
	}))
	if err != nil {
		return nil, err
	}
	return &ddbAccount{dynamodb.NewFromConfig(cfg), accountDb}, nil
}

func (a *ddbAccount) GetAccountByAci(aci []byte) (*Account, error) {
	proj := expression.NamesList(expression.Name(attrCanonicallyDiscoverable), expression.Name(attrUnidentifiedAccessKey))
	expr, err := expression.NewBuilder().WithProjection(proj).Build()

	if err != nil {
		return nil, err
	}
	result, err := a.conn.GetItem(context.Background(), &dynamodb.GetItemInput{
		Key: map[string]types.AttributeValue{
			attrAci: &types.AttributeValueMemberB{Value: aci[:]},
		},
		TableName:                aws.String(a.accountDb),
		ConsistentRead:           aws.Bool(true),
		ExpressionAttributeNames: expr.Names(),
		ProjectionExpression:     expr.Projection(),
	})

	if err != nil {
		return nil, err
	}

	if len(result.Item) == 0 {
		return nil, nil
	}

	account := Account{}
	err = attributevalue.UnmarshalMap(result.Item, &account)

	if err != nil {
		return nil, err
	}

	return &account, nil
}
