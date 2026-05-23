# Tooling Setup Log

Date: 2026-05-23

## Environment confirmed

- OS: Windows
- Active project folder: C:\Users\annem\Projects\STR-Operations-App
- Project deliberately moved outside OneDrive to avoid sync conflicts with node_modules and Git.
- Editor: VS Code, project folder open
- Node.js: v24.16.0
- npm: 11.13.0, use npm.cmd on Windows PowerShell
- pnpm: 11.2.2, use pnpm.cmd on Windows PowerShell
- Git: 2.51.0.windows.1
- Verified that node -v and pnpm.cmd -v run correctly from inside the project folder.

## Windows-specific rules

- PowerShell blocks npm.ps1, so use npm.cmd and pnpm.cmd.
- Do not change Windows execution policy unless a future step specifically requires it.

## Source control confirmed

- Local Git repo created.
- Default branch: main
- First commit: Initial planning baseline
- Working tree confirmed clean.
- Private GitHub repo created and connected as origin:
  https://github.com/Ohannii/STR-Operations-App
- First push to GitHub completed.
- GitHub shows:
  - .gitignore
  - CLAUDE_PROJECT_SKILLSET.md
  - docs/
  - prompts/

## Safety net confirmed

.gitignore verified and protects:
- node_modules/
- .next/
- out/
- dist/
- build/
- .env
- .env.*
- .vercel/
- .supabase/
- OS junk files

.env.example is allowed intentionally as a safe blank template file.

## Git identity

- user.name = Anni du Plessis
- user.email = 219782078+Ohannii@users.noreply.github.com
- GitHub email privacy is on.

## Explicitly not done yet

- No app code created.
- No pnpm install run inside the project.
- No Next.js project created.
- No database migrations.
- No Supabase connection.
- No Vercel connection.
- No deployment.

## Next correct step

Before creating the Next.js skeleton, incorporate the Replit prototype findings into the official planning documents.

The Replit prototype was only a throwaway UX test and must not be treated as production code.
