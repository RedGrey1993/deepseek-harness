# Agent Note: Codex sign-in from Models settings

Status: implemented

English | [中文](2026-09-16-models-codex-sign-in.zh.md)

## Problem

The installed pi-ai catalog exposes Codex models and its authorization adapter registers a login flow, but the Models page cannot start that flow or show its notices. A reference-free route can also appear ready without a stored account credential.

## Decision

The settings controller projects the existing authorization service onto a caller-private Remote stream. Only the initiating card receives the authorization URL, device code, and input prompts. Prompt replies use attempt-specific capabilities. Closing the card cancels its attempt; a provider withdrawing a manual-code prompt does not cancel a browser callback still in progress. Stored tokens stay in the existing credential provider, and pi-ai retains protocol and refresh ownership.

The built-in Codex editor exposes account controls through localhost and derives readiness from stored grant metadata. The Host methods retain the existing configuration transport authentication and Host/Origin policy. An explicit API credential reference remains authoritative and is reported as an override instead of silently discarded.

## Alternatives considered

**Reimplement OAuth in the Web plugin.** Rejected because the installed pi-ai adapter already owns login, token storage integration, and refresh.

**Broadcast login notices as global events.** Rejected because another browser must not receive the initiating user's authorization URL or device code.

**Read the Codex CLI credential file.** Rejected because this feature needs its own Harness credential lifecycle and does not need to share rotating tokens with another application.

## Consequences

The existing provider settings and credential formats remain unchanged. Users explicitly open the authorization link, so browser popup blocking cannot hide the login instructions. Account sign-in and provider settings are separate operations: Apply saves the route after login. A disconnected or closed card starts a fresh attempt on retry. Real account authorization still requires the user to complete the provider's consent flow.
