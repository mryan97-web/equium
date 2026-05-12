FROM rust:1.81

WORKDIR /app

COPY . .

RUN cargo build --release

CMD ["cargo", "run"]
