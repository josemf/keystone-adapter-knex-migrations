#!/usr/bin/env sh
 
docker run --name test-maria10 -p 3306:3306 -e MYSQL_ROOT_PASSWORD=mysql -e MYSQL_DATABASE=test -d mariadb:10
