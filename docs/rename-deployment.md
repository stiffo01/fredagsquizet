# Rename an existing deployment without losing quizzes

These steps run on the server in its existing checkout. Keep its `.env` file. The host port and URL can stay the same. A restart ends active games; saved quizzes and uploaded images live in the data volume.

The safest option is to rename the application, project, and container while reusing the existing volume. Its old internal name does not affect the application.

1. Identify the running container with `docker ps -a`. In the following commands, replace `fredagsquizet` if its current container name differs. Record the Compose project and the volume mounted at `/app/data`:

   ```sh
   docker inspect fredagsquizet --format '{{index .Config.Labels "com.docker.compose.project"}}'
   docker inspect fredagsquizet --format '{{range .Mounts}}{{println .Type .Name .Source "->" .Destination}}{{end}}'
   ```

   Stop here if `/app/data` is a bind mount rather than a named volume: retain that exact host path in the new Compose file instead.

2. Stop the old project using its current Compose file. Substitute the project name found above. **Do not add `-v`**:

   ```sh
   docker compose -p OLD_PROJECT down
   ```

3. Back up the volume. Substitute its exact existing name. Mounting a misspelled name can create an empty volume, so inspect it first:

   ```sh
   docker volume inspect OLD_VOLUME
   docker run --rm --network none \
     --mount type=volume,src=OLD_VOLUME,dst=/source,readonly \
     node:24-alpine tar -C /source -cpf - . > fredagsquizet-backup.tar
   tar -tf fredagsquizet-backup.tar
   ```

   Check that the archive contains `quizzes.json` and any uploaded `media/` files before proceeding.

4. Update the code and retain the server's `.env`. Set these Compose entries, keeping all existing service settings, including the port and environment variables:

   ```yaml
   name: fredagsquizet
   services:
     fredagsquizet:
       container_name: fredagsquizet
       image: fredagsquizet:latest
       build: .
       # Keep the existing ports, environment, security settings, etc.
       volumes:
         - quiz-data:/app/data

   volumes:
     quiz-data:
       external: true
       name: OLD_VOLUME
   ```

   Replace `OLD_VOLUME` with the actual name, for example `kahoot-local_quiz-data`. `external: true` makes Compose fail if the volume is missing, instead of silently creating an empty one. Remove any old `COMPOSE_PROJECT_NAME` override from the deployment environment. If the old directory name is also being changed, rename the directory after step 2 and run subsequent commands there.

5. Start and verify:

   ```sh
   docker compose up --build -d
   docker compose ps
   docker inspect fredagsquizet --format '{{range .Mounts}}{{println .Name "->" .Destination}}{{end}}'
   ```

   Open the host library and confirm the quizzes and pictures are present. Keep the backup. Never use `down -v` as part of a rename.

If the volume name must also change, create a new empty volume, copy `/source/.` into it with `cp -a`, and compare both volumes using `diff -r` while the old service is stopped. Only point Compose to the new volume after that comparison succeeds. Keep the original volume and archive as recovery copies until the new deployment has been verified.
