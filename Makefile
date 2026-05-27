.PHONY: deploy push logs status open env backend mobile help

FRONTEND_DIR = app/frontend
BACKEND_DIR  = app/backend
MOCK_DIR     = app/mock-server

## ── Deploy ────────────────────────────────────────────────────────────────

# Push code to GitHub (triggers auto-deploy once GitHub is connected to Vercel)
push:
	git add -A
	@read -p "Commit message: " msg; git commit -m "$$msg"
	git push

# Force a Vercel production deploy right now (without a git push)
deploy:
	vercel --prod --yes

## ── Monitor ───────────────────────────────────────────────────────────────

# Stream live Vercel function logs
logs:
	vercel logs https://frontend-five-rho-16.vercel.app --follow

# Show latest deployment status
status:
	vercel ls

# Open the live app in browser
open:
	open https://frontend-five-rho-16.vercel.app

## ── Environment variables ─────────────────────────────────────────────────

# List all Vercel env vars for production
env:
	vercel env ls production

# Set a Vercel env var: make set-env KEY=FOO VALUE=bar
set-env:
	@printf '$(VALUE)' | vercel env add $(KEY) production --force
	vercel --prod --yes

## ── Local dev ─────────────────────────────────────────────────────────────

# Start backend + mock server together
backend:
	cd $(MOCK_DIR)  && npm run dev &
	cd $(BACKEND_DIR) && npm run dev

# Start frontend dev server (talks to local backend)
frontend:
	cd $(FRONTEND_DIR) && npm run dev

## ── Git helpers ───────────────────────────────────────────────────────────

# Show current git status and recent commits
git-status:
	@echo "\n── Staged / unstaged ──────────────────────────"
	@git status --short
	@echo "\n── Recent commits ─────────────────────────────"
	@git log --oneline -8

## ── Help ──────────────────────────────────────────────────────────────────

help:
	@echo ""
	@echo "Alert Insurance — project commands"
	@echo ""
	@echo "  make push        Commit all changes and push to GitHub"
	@echo "  make deploy      Force Vercel production deploy now"
	@echo "  make logs        Stream live serverless function logs"
	@echo "  make status      Show recent Vercel deployments"
	@echo "  make open        Open live app in browser"
	@echo "  make env         List production environment variables"
	@echo "  make backend     Start local backend + mock server"
	@echo "  make frontend    Start local React dev server"
	@echo "  make git-status  Show git status + recent commits"
	@echo ""
