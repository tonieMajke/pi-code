set -e
t=$(mktemp -d)
mkdir -p "$t/my docs"
echo hi > "$t/my docs/a.txt"
bash backup.sh "$t/my docs" "$t/out dir/nested"
test -f "$t/out dir/nested/my docs.tar.gz"
tar -tzf "$t/out dir/nested/my docs.tar.gz" | grep -q "my docs/a.txt"
echo OK
