.PHONY: install serve clean lint-md

JEKYLL_IMAGE := jekyll/jekyll:4
JEKYLL_PORT  := 4000

# Install Jekyll dependencies (requires Ruby 3+, or use 'make serve' with Docker)
install:
	bundle install

# Serve the Jekyll site locally via Docker (no local Ruby needed)
serve:
	docker run --rm \
		-v "$(CURDIR):/srv/jekyll:Z" \
		-p $(JEKYLL_PORT):4000 \
		-p 35729:35729 \
		$(JEKYLL_IMAGE) \
		jekyll serve --livereload --force_polling --incremental --host 0.0.0.0

# Lint all workshop markdown files
lint-md:
	npx markdownlint-cli2 "*.md" "!README.md" "!AGENTS.md" "!GEMINI.md" "!CLAUDE.md"

# Clean Jekyll build artifacts
clean:
	rm -rf _site .jekyll-cache .sass-cache
