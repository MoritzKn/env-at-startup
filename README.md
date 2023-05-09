# env-at-startup

## How to use

You need to add the following to your Dockerfile

### 1st Download the Script

```Dockerfile
RUN curl https://raw.githubusercontent.com/MoritzKn/env-at-startup/main/index.js -o env-at-startup \
 && chmod +x env-at-startup
```

### 2st Run the script before start up

If you have a `docker-entrypoint.sh` you can do this:
(assuming your `docker-entrypoint.sh` ends with `exec "$@"` this is usually the case)

```Dockerfile
RUN apk add nodejs \
 # Delete the last line containing `exec "$@"`
 && sed -i '/exec "$@"/d' docker-entrypoint.sh \
 # Append the /env-at-startup command
 && echo './env-at-startup $(find . -name "*.js")' >> docker-entrypoint.sh \
 # Add the `exec "$@"` line again
 && echo 'exec "$@"' >> docker-entrypoint.sh
```

If you are using something like `npm run start`, you could also change your CMD like so:

```Dockerfile
CMD ["/bin/sh", "-c", "./env-at-startup $(find . -name '*.js') && npm run start"]
```

## Example

Here is a full example of a classical frontend app:

```Dockerfile
FROM node:alpine as build
WORKDIR /app

RUN curl https://raw.githubusercontent.com/MoritzKn/env-at-startup/main/index.js -o env-at-startup \
 && chmod +x env-at-startup

COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile --prod

COPY src src
RUN yarn build

FROM nginx:1-alpine
EXPOSE 5000

COPY nginx.conf /etc/nginx/conf.d/default.conf
# Copy the out directory (make sure to adjust this!)
COPY --from=build /app/out/ /usr/share/nginx/html
COPY --from=build /app/env-at-startup /env-at-startup

RUN apk add nodejs \
 # Delete the last line containing `exec "$@"`
 && sed -i '/exec "$@"/d' docker-entrypoint.sh \
 # Append the /env-at-startup command
 && echo './env-at-startup $(find . -name "*.js")' >> docker-entrypoint.sh \
 # Add the `exec "$@"` line again
 && echo 'exec "$@"' >> docker-entrypoint.sh
```
