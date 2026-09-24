#!/usr/bin/env bash
# usage: backup.sh <source-dir> <dest-dir>
set -e
src=$1
dest=$2
name=$(basename $src)
tar -czf $dest/$name.tar.gz -C $(dirname $src) $name
echo "saved $dest/$name.tar.gz"
