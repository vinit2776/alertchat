.PHONY: deploy push logs status open env set-env backend frontend automation migrate railway-logs railway-status help

FRONTEND_DIR  = app/frontend
BACKEND_DIR   = app/backend
AUTOMATION_DIR = app/automation
MOCK_DIR      = app/mock-server

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

## ── Railway (automation backend) ─────────────────────────────────────────

# Stream live Railway logs
railway-logs:
	railway logs --tail

# Show Railway deployment status
railway-status:
	railway status

# Open Railway dashboard
railway-open:
	railway open

## ── Local dev ─────────────────────────────────────────────────────────────

# Start backend + mock server together
backend:
	cd $(MOCK_DIR)  && npm run dev &
	cd $(BACKEND_DIR) && npm run dev

# Start automation service locally
automation:
	cd $(AUTOMATION_DIR) && npm run dev

# Run DB migrations (local)
migrate:
	cd $(AUTOMATION_DIR) && npm run migrate

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
	@echo "  make push            Commit all changes and push to GitHub"
	@echo "  make deploy          Force Vercel production deploy now"
	@echo "  make logs            Stream live Vercel function logs"
	@echo "  make status          Show recent Vercel deployments"
	@echo "  make open            Open live app in browser"
	@echo "  make env             List Vercel production env vars"
	@echo "  make railway-logs    Stream live Railway (automation) logs"
	@echo "  make railway-status  Show Railway deployment status"
	@echo "  make railway-open    Open Railway dashboard"
	@echo "  make backend         Start local legacy backend"
	@echo "  make automation      Start local automation service"
	@echo "  make migrate         Run DB migrations locally"
	@echo "  make frontend        Start local React dev server"
	@echo "  make git-status      Show git status + recent commits"
	@echo ""
