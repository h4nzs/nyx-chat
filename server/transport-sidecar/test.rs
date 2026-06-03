use redis::AsyncCommands;
#[tokio::main]
async fn main() {
    let client = redis::Client::open("redis://127.0.0.1/").unwrap();
    let pubsub = client.get_async_pubsub().await.unwrap();
}
