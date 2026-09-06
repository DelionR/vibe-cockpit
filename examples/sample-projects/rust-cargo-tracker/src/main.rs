fn main() {
    let items = vec!["design", "code", "ship"];
    for item in &items {
        println!("track: {}", item);
    }
    println!("total = {}", add(items.len() as i64, 1));
}

pub fn add(a: i64, b: i64) -> i64 {
    a + b
}
