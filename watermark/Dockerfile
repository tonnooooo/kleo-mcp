# The kleo-watermark Container: ffmpeg + the small HTTP server that burns the Kleo mark into a clip (server.py).
# Built by wrangler on GitHub's runners (.github/workflows/watermark.yml, from github-workflow.yml), never on the owner's PC.
FROM alpine:3.22
RUN apk add --no-cache ffmpeg python3 && adduser -D -H marker
WORKDIR /app
COPY server.py made-with-kleo.png ./
USER marker
EXPOSE 8080
CMD ["python3", "-u", "/app/server.py"]
