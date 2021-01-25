#!/usr/bin/env sh
 
docker run --name test-mysql57 -p 3306:3306 -e MYSQL_ROOT_PASSWORD=mysql -e MYSQL_DATABASE=mysql -d mysql:5.7
