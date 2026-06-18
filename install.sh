#!/bin/bash

# Solana Agent Ops, skill installer
# Copies the skill into ~/.claude/skills/ (and optionally agents/commands/rules into your config).
# Pure file copy. No network calls, no executables fetched.

set -e

GREEN='\033[0;32m'; CYAN='\033[0;36m'; YELLOW='\033[1;33m'; RED='\033[0;31m'
MAGENTA='\033[0;35m'; WHITE='\033[1;37m'; NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILLS_DIR="$HOME/.claude/skills"
SKILL_PATH="$SKILLS_DIR/solana-agent-ops"
CLAUDE_DIR="$HOME/.claude"

WITH_CONFIG=false
SKIP_CONFIRM=false
while [[ $# -gt 0 ]]; do
  case $1 in
    --with-config) WITH_CONFIG=true; shift ;;
    -y|--yes) SKIP_CONFIRM=true; shift ;;
    -h|--help)
      echo "Usage: ./install.sh [--with-config] [-y]"
      echo "  (default)        Install the skill into ~/.claude/skills/solana-agent-ops"
      echo "  --with-config    Also copy agents/, commands/, rules/ into ~/.claude/"
      echo "  -y, --yes        Skip confirmation"
      exit 0 ;;
    *) echo "Unknown option: $1 (use --help)"; exit 1 ;;
  esac
done

echo ""
echo -e "${MAGENTA}╔════════════════════════════════════════════════════════╗${NC}"
echo -e "${MAGENTA}║${NC}   ${WHITE}Solana Agent Ops for Claude Code / Codex${NC}     ${MAGENTA}║${NC}"
echo -e "${MAGENTA}║${NC}   ${CYAN}Keep your bots alive and safe in production${NC}          ${MAGENTA}║${NC}"
echo -e "${MAGENTA}╚════════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "This installs:"
echo -e "  ${CYAN}•${NC} skill          → ${CYAN}$SKILL_PATH${NC}"
if [ "$WITH_CONFIG" = true ]; then
  echo -e "  ${CYAN}•${NC} agents/        → ${CYAN}$CLAUDE_DIR/agents/${NC}"
  echo -e "  ${CYAN}•${NC} commands/      → ${CYAN}$CLAUDE_DIR/commands/${NC}"
  echo -e "  ${CYAN}•${NC} rules/         → ${CYAN}$CLAUDE_DIR/rules/${NC}"
fi
echo ""

if [ "$SKIP_CONFIRM" = false ]; then
  read -p "Proceed? [Y/n] " -n 1 -r; echo
  [[ $REPLY =~ ^[Nn]$ ]] && { echo -e "${YELLOW}Cancelled${NC}"; exit 0; }
fi

mkdir -p "$SKILLS_DIR"
[ -d "$SKILL_PATH" ] && { echo -e "${YELLOW}→${NC} replacing existing install"; rm -rf "$SKILL_PATH"; }
mkdir -p "$SKILL_PATH"
cp -r "$SCRIPT_DIR/skill/"* "$SKILL_PATH/"
echo -e "${GREEN}✓${NC} skill installed"

if [ "$WITH_CONFIG" = true ]; then
  mkdir -p "$CLAUDE_DIR/agents" "$CLAUDE_DIR/commands" "$CLAUDE_DIR/rules"
  cp "$SCRIPT_DIR/agents/"*.md   "$CLAUDE_DIR/agents/"   2>/dev/null || true
  cp "$SCRIPT_DIR/commands/"*.md "$CLAUDE_DIR/commands/" 2>/dev/null || true
  cp "$SCRIPT_DIR/rules/"*.md    "$CLAUDE_DIR/rules/"    2>/dev/null || true
  echo -e "${GREEN}✓${NC} agents / commands / rules installed"
fi

echo ""
echo -e "${GREEN}Done.${NC} Try asking Claude:"
echo -e "  ${CYAN}•${NC} \"Why isn't my transaction landing?\" (paste a signature)"
echo -e "  ${CYAN}•${NC} \"Make this bot crash-safe so a restart doesn't double-send\""
echo -e "  ${CYAN}•${NC} \"Audit my keeper against the pre-mainnet safety gate\""
echo ""
echo -e "${MAGENTA}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${YELLOW}  A community skill for the Solana AI Kit${NC}"
echo -e "${MAGENTA}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
