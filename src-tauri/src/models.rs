//! The model router's configuration: the routing plan NewPi hands the harness.
//!
//! NewPi does not own a provider registry and does not want one. The harness
//! already has exactly one — `ctx.llm`, an adapter registry with a streaming
//! call API — and the agent layer already has exactly one selection value, the
//! `{ provider, model, reasoningEffort }` triple an agent is created with.
//! What NewPi owns is the *policy*: which of those triples a request gets, by
//! mode and by role. This module is where that policy is read and validated.
//!
//! The user writes it in the project's own `cordis.yml`, next to the memory
//! scope:
//!
//! ```yaml
//! model_router:
//!   mode: auto
//!   roles:
//!     coding:
//!       provider: deepseek
//!       model: deepseek-v4
//!       reasoning: high
//!       fallback:
//!         provider: glm
//!         model: glm-5.3
//!     default:
//!       provider: deepseek
//!       model: deepseek-chat
//!   requirements:
//!     coding:
//!       tools: true
//!       max_context: 64000
//! ```
//!
//! A plan that validates is serialized to JSON and carried as one launcher
//! patch scalar, so the plugin that implements the routing is configured the
//! same way every other NewPi plugin is: through the patch, compiled from the
//! same source as the code that reads it.
//!
//! # What is deliberately *not* here
//!
//! No credential. A provider route is named, never authenticated: the
//! harness's own settings (`$DSH_HOME/settings.yaml`, the `llm-deepseek:` and
//! `llm-pi-ai:` sections) and the environment own every key. A key-looking
//! field in this block is refused rather than ignored, because the only
//! acceptable place for it is somewhere else.
//!
//! # Why the plan is validated here and again in the plugin
//!
//! Here, because a mistake in the user's own document should be reported
//! before the harness starts, in the language of the file the user edited.
//! There, because the plugin is also loadable by hand and must not trust its
//! input. The two checks are small and answer different questions.

use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::memory::{strip_comment, unquote};
use crate::patch::Row;

/// The top level key the plan lives under, in the project's `cordis.yml`.
pub const CONFIG_SECTION: &str = "model_router";

/// The row id, and the deployed plugin directory name.
pub const ROW_ID: &str = "model-router";

/// The role vocabulary. A role is a *task* the router answers for; it is never
/// a provider or a model, and the two must not be conflated.
pub const ROLES: [&str; 6] = [
    "fast",
    "coding",
    "reasoning",
    "research",
    "review",
    "default",
];

/// Keys anywhere in the block that would mean a secret was placed here.
///
/// Compared against each lowercased key: a key that merely *contains* one of
/// these is refused, so `api_key`, `apiKey` and `provider_token` all fail.
const SECRET_MARKERS: [&str; 7] = [
    "api_key",
    "apikey",
    "api-key",
    "token",
    "secret",
    "password",
    "credential",
];

/// The mode the router runs in.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    /// The configured selection, and nothing else. No role, no fallback.
    Manual,
    /// One mutable active selection, changed at runtime through the service.
    Switch,
    /// A selection per requested role, resolved by the router.
    Auto,
}

impl Mode {
    /// The mode a configuration scalar names.
    ///
    /// @param value - the scalar, already unquoted.
    /// @returns the mode, or `None` when it names none of them.
    fn parse(value: &str) -> Option<Self> {
        match value {
            "manual" => Some(Self::Manual),
            "switch" => Some(Self::Switch),
            "auto" => Some(Self::Auto),
            _ => None,
        }
    }
}

/// One `{ provider, model, reasoningEffort }` route.
///
/// The JSON field name is the harness's own (`ModelSelection`), while the YAML
/// key the user writes is `reasoning`: the mapping happens once, here, so no
/// consumer has to guess.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Selection {
    /// Registered provider route, as the harness's `llm` service knows it.
    pub provider: String,
    /// Provider-owned model id.
    pub model: String,
    /// Adapter-owned reasoning effort, when one was chosen.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning_effort: Option<String>,
}

/// A light capability declaration: what a route can do, and what a task needs.
///
/// Both the route's own declaration and a role's requirements use this shape.
/// Every field is optional: an absent capability is *unknown*, never `false`,
/// so a deployment that declares nothing is not treated as incapable.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    /// Whether the route can call tools.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tools: Option<bool>,
    /// Whether the route exposes selectable reasoning efforts.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning: Option<bool>,
    /// Whether the route accepts image input.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vision: Option<bool>,
    /// Maximum combined request and response context, in tokens.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_context: Option<u64>,
}

impl Capabilities {
    /// Whether nothing at all is declared.
    fn is_empty(&self) -> bool {
        self.tools.is_none()
            && self.reasoning.is_none()
            && self.vision.is_none()
            && self.max_context.is_none()
    }
}

/// One role's route: the primary selection, and what to do when it fails.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RoleRoute {
    /// The selection this role resolves to.
    #[serde(flatten)]
    pub primary: Selection,
    /// The route a fallback-eligible failure moves to, when one is declared.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fallback: Option<Selection>,
    /// The route's own capability declaration, when the deployment has one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub capabilities: Option<Capabilities>,
}

/// A validated routing plan.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Plan {
    /// The active mode.
    pub mode: Mode,
    /// The imposed selection, required in `manual` mode.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub manual: Option<Selection>,
    /// The starting selection in `switch` mode, mutable at runtime.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active: Option<Selection>,
    /// The role map, required in `auto` mode (at least `default`).
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub roles: BTreeMap<String, RoleRoute>,
    /// Per role requirements, keyed by the role a caller *asks for*.
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub requirements: BTreeMap<String, Capabilities>,
}

// --------------------------------------------------------------- the document

/// One line of the block, with its indentation kept.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Entry {
    indent: usize,
    key: String,
    value: Option<String>,
    line: usize,
}

/// One node of the block's tree.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Node {
    key: String,
    value: Option<String>,
    children: Vec<Node>,
    line: usize,
}

impl Plan {
    /// Resolve and validate the plan declared by one workspace.
    ///
    /// @param workspace - the workspace root the harness runs in.
    /// @returns the plan, or `None` when the project declares no
    ///   `model_router` block — in which case NewPi mounts no router at all and
    ///   the harness behaves exactly as it did before the feature existed.
    /// @throws a message naming the key at fault when the file exists, declares
    ///   a plan, and that plan does not validate.
    pub fn resolve(workspace: &Path) -> Result<Option<Self>, String> {
        let config = workspace.join(crate::memory::PROJECT_CONFIG);
        if !config.is_file() {
            return Ok(None);
        }
        let text = std::fs::read_to_string(&config)
            .map_err(|error| format!("Lecture impossible de {} : {error}", config.display()))?;
        Self::parse(&text)
    }

    /// Parse the `model_router` block out of a project configuration.
    ///
    /// @param text - the whole file.
    /// @returns the plan, or `None` when the block is absent.
    /// @throws a message naming the offending key or line.
    pub fn parse(text: &str) -> Result<Option<Self>, String> {
        let Some(entries) = section_entries(text, CONFIG_SECTION)? else {
            return Ok(None);
        };
        if entries.is_empty() {
            return Err(format!(
                "{CONFIG_SECTION}: the block is empty; it must at least declare `mode`",
            ));
        }

        let mut cursor = 0;
        let root = build(&entries, &mut cursor, None)?;
        assert_no_secrets(&root, CONFIG_SECTION)?;
        expect_keys(
            &root,
            &["mode", "manual", "active", "roles", "requirements"],
            CONFIG_SECTION,
        )?;

        let mode_value = expect_scalar(&root, "mode", CONFIG_SECTION, true)?
            .ok_or_else(|| format!("{CONFIG_SECTION}.mode is required"))?;
        let mode = Mode::parse(mode_value).ok_or_else(|| {
            format!(
                "{CONFIG_SECTION}.mode: `{mode_value}` is not a mode; use manual, switch or auto",
            )
        })?;

        let manual = expect_block(&root, "manual", CONFIG_SECTION, false)?
            .map(|node| selection(node, &format!("{CONFIG_SECTION}.manual")))
            .transpose()?;
        let active = expect_block(&root, "active", CONFIG_SECTION, false)?
            .map(|node| selection(node, &format!("{CONFIG_SECTION}.active")))
            .transpose()?;

        let mut roles: BTreeMap<String, RoleRoute> = BTreeMap::new();
        if let Some(node) = expect_block(&root, "roles", CONFIG_SECTION, false)? {
            for role in &node.children {
                let path = format!("{CONFIG_SECTION}.roles.{}", role.key);
                if !ROLES.contains(&role.key.as_str()) {
                    return Err(format!(
                        "{path}: `{}` is not a role; use one of {}",
                        role.key,
                        ROLES.join(", "),
                    ));
                }
                let route = role_route(role, &path)?;
                roles.insert(role.key.clone(), route);
            }
        }

        let mut requirements: BTreeMap<String, Capabilities> = BTreeMap::new();
        if let Some(node) = expect_block(&root, "requirements", CONFIG_SECTION, false)? {
            for role in &node.children {
                let path = format!("{CONFIG_SECTION}.requirements.{}", role.key);
                if !ROLES.contains(&role.key.as_str()) {
                    return Err(format!(
                        "{path}: `{}` is not a role; use one of {}",
                        role.key,
                        ROLES.join(", "),
                    ));
                }
                let declared = capabilities(role, &path)?;
                // Requirements for a role with no mapping are legal and useful:
                // the caller still asked for that role, so its needs apply to
                // whichever route the role resolves to.
                requirements.insert(role.key.clone(), declared);
            }
        }

        let plan = Self {
            mode,
            manual,
            active,
            roles,
            requirements,
        };
        plan.validate()?;
        Ok(Some(plan))
    }

    /// Check the relationships a per-field check cannot see.
    fn validate(&self) -> Result<(), String> {
        match self.mode {
            Mode::Manual if self.manual.is_none() => Err(format!(
                "{CONFIG_SECTION}: mode `manual` requires a `manual:` provider and model",
            )),
            Mode::Switch if self.active.is_none() => Err(format!(
                "{CONFIG_SECTION}: mode `switch` requires an `active:` provider and model",
            )),
            Mode::Auto if !self.roles.contains_key("default") => Err(format!(
                "{CONFIG_SECTION}: mode `auto` requires `roles.default`, \
                 the route every unmapped role falls back to",
            )),
            _ => Ok(()),
        }
    }

    /// The plan as the one launcher-patch scalar the plugin reads.
    ///
    /// @returns compact JSON; the patch quotes it as a single scalar.
    /// @throws a message when serialization fails, which the types make
    ///   impossible — reported rather than panicked so a launch never dies in a
    ///   formatter.
    pub fn to_json(&self) -> Result<String, String> {
        serde_json::to_string(self)
            .map_err(|error| format!("Sérialisation du plan de routage impossible : {error}"))
    }

    /// The launcher patch row that mounts the router with this plan.
    ///
    /// @param layout - the resolved layout, whose plugin paths the row points at.
    /// @param plan - the validated plan.
    /// @returns the row.
    /// @throws a message when the plan cannot be serialized.
    pub fn row(&self, layout: &crate::memory::Layout) -> Result<Row, String> {
        Ok(
            Row::plugin(ROW_ID, &layout.plugins.join("model-router/index.js"))
                .with_config("plan", self.to_json()?),
        )
    }
}

/// The `Entry` list of one top level block, or `None` when it is not declared.
///
/// The walk is deliberately narrow: it reads one block of one small document
/// and refuses anything it does not understand, because a plan half-read is a
/// route silently pointed somewhere the user did not write.
fn section_entries(text: &str, section: &str) -> Result<Option<Vec<Entry>>, String> {
    let mut entries: Vec<Entry> = Vec::new();
    let mut inside = false;
    let mut declared_at: Option<usize> = None;

    for (index, raw) in text.lines().enumerate() {
        let number = index + 1;
        let line = strip_comment(raw);
        if line.trim().is_empty() || line.trim_start().starts_with("---") {
            continue;
        }
        let indent = indentation(&line, number)?;
        let trimmed = line.trim();

        if indent == 0 {
            // A new top level key ends whatever block we were in.
            let (key, value) = split_key(trimmed, number)?;
            if key == section {
                if let Some(first) = declared_at {
                    return Err(format!(
                        "line {number}: `{section}` is declared twice (the first is on line {first}); \
                         keep one plan, because two would be merged and one would silently win",
                    ));
                }
                if value.is_some() {
                    return Err(format!(
                        "line {number}: `{section}` must be a block of keys, not a scalar",
                    ));
                }
                declared_at = Some(number);
                inside = true;
                continue;
            }
            if inside {
                break;
            }
            continue;
        }

        if !inside {
            // Indentation below some other top level key is not ours.
            continue;
        }

        let (key, value) = split_key(trimmed, number)?;
        entries.push(Entry {
            indent,
            key: unquote(&key),
            value: value.map(|value| unquote(&value)),
            line: number,
        });
    }

    Ok(if inside { Some(entries) } else { None })
}

/// Leading spaces of one line; a tab is refused because YAML forbids it.
fn indentation(line: &str, number: usize) -> Result<usize, String> {
    let mut count = 0;
    for character in line.chars() {
        match character {
            ' ' => count += 1,
            '\t' => {
                return Err(format!(
                    "line {number}: a tab cannot indent YAML; use spaces",
                ))
            }
            _ => break,
        }
    }
    Ok(count)
}

/// Split `key: value` (or `key:`), refusing anything else.
fn split_key(trimmed: &str, number: usize) -> Result<(String, Option<String>), String> {
    let Some((key, rest)) = trimmed.split_once(':') else {
        return Err(format!(
            "line {number}: `{trimmed}` is not a `key: value` line",
        ));
    };
    if key.is_empty() || key.contains(char::is_whitespace) {
        return Err(format!("line {number}: `{key}` is not a usable key"));
    }
    let rest = rest.trim();
    Ok((
        key.to_string(),
        if rest.is_empty() {
            None
        } else {
            Some(rest.to_string())
        },
    ))
}

/// Build the block's tree from its flat, indentation-tagged lines.
fn build(
    entries: &[Entry],
    cursor: &mut usize,
    parent: Option<usize>,
) -> Result<Vec<Node>, String> {
    let mut nodes: Vec<Node> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let mut child_indent: Option<usize> = None;

    while *cursor < entries.len() {
        let entry = &entries[*cursor];
        if let Some(indent) = parent {
            if entry.indent <= indent {
                break;
            }
        }
        match child_indent {
            None => child_indent = Some(entry.indent),
            Some(expected) if entry.indent != expected => {
                return Err(format!(
                    "line {}: indentation {} does not match its siblings at {expected}",
                    entry.line, entry.indent,
                ));
            }
            Some(_) => {}
        }
        if !seen.insert(entry.key.clone()) {
            return Err(format!(
                "line {}: `{}` is declared twice at the same level",
                entry.line, entry.key,
            ));
        }
        *cursor += 1;

        let children = if entry.value.is_none() {
            build(entries, cursor, Some(entry.indent))?
        } else {
            if let Some(next) = entries.get(*cursor) {
                if next.indent > entry.indent {
                    return Err(format!(
                        "line {}: `{}` has a scalar value and nested keys below it",
                        entry.line, entry.key,
                    ));
                }
            }
            Vec::new()
        };

        nodes.push(Node {
            key: entry.key.clone(),
            value: entry.value.clone(),
            children,
            line: entry.line,
        });
    }

    Ok(nodes)
}

/// Refuse a plan that carries anything credential-shaped.
fn assert_no_secrets(nodes: &[Node], path: &str) -> Result<(), String> {
    for node in nodes {
        let lowered = node.key.to_ascii_lowercase();
        if SECRET_MARKERS.iter().any(|marker| lowered.contains(marker)) {
            return Err(format!(
                "{path}.{}: credentials do not belong in this file; \
                 they are owned by the harness settings (`$DSH_HOME/settings.yaml`) \
                 and the environment",
                node.key,
            ));
        }
        assert_no_secrets(&node.children, &format!("{path}.{}", node.key))?;
    }
    Ok(())
}

/// Refuse a key this schema does not define, so a typo cannot be ignored.
fn expect_keys(nodes: &[Node], allowed: &[&str], path: &str) -> Result<(), String> {
    for node in nodes {
        if !allowed.contains(&node.key.as_str()) {
            return Err(format!(
                "{path}.{} (line {}): unknown key; expected one of {}",
                node.key,
                node.line,
                allowed.join(", "),
            ));
        }
    }
    Ok(())
}

/// Read a required or optional scalar, refusing an empty one.
fn expect_scalar<'a>(
    nodes: &'a [Node],
    key: &str,
    path: &str,
    required: bool,
) -> Result<Option<&'a str>, String> {
    match nodes.iter().find(|node| node.key == key) {
        None if required => Err(format!("{path}.{key} is required")),
        None => Ok(None),
        Some(node) => match node.value.as_deref() {
            Some(value) if !value.is_empty() => Ok(Some(value)),
            _ => Err(format!("{path}.{key} must be a non-empty scalar")),
        },
    }
}

/// Read a required or optional nested block.
fn expect_block<'a>(
    nodes: &'a [Node],
    key: &str,
    path: &str,
    required: bool,
) -> Result<Option<&'a Node>, String> {
    match nodes.iter().find(|node| node.key == key) {
        None if required => Err(format!("{path}.{key} is required")),
        None => Ok(None),
        Some(node) if node.value.is_some() => Err(format!("{path}.{key} must be a block of keys")),
        Some(node) => Ok(Some(node)),
    }
}

/// Parse a `{ provider, model, reasoning }` block whose keys are exactly its own.
fn selection(node: &Node, path: &str) -> Result<Selection, String> {
    expect_keys(&node.children, &["provider", "model", "reasoning"], path)?;
    read_selection(&node.children, path)
}

/// Read the three selection fields out of a node that may carry other keys too.
///
/// A role node is the case: it holds a selection *and* a fallback and a
/// capability declaration, so the key check belongs to the caller.
fn read_selection(nodes: &[Node], path: &str) -> Result<Selection, String> {
    let provider = expect_scalar(nodes, "provider", path, true)?
        .ok_or_else(|| format!("{path}.provider is required"))?;
    let model = expect_scalar(nodes, "model", path, true)?
        .ok_or_else(|| format!("{path}.model is required"))?;
    Ok(Selection {
        provider: provider.to_string(),
        model: model.to_string(),
        reasoning_effort: expect_scalar(nodes, "reasoning", path, false)?.map(str::to_string),
    })
}

/// Parse one role's route.
fn role_route(node: &Node, path: &str) -> Result<RoleRoute, String> {
    expect_keys(
        &node.children,
        &["provider", "model", "reasoning", "fallback", "capabilities"],
        path,
    )?;
    let primary = read_selection(&node.children, path)?;
    let fallback = expect_block(&node.children, "fallback", path, false)?
        .map(|child| selection(child, &format!("{path}.fallback")))
        .transpose()?;

    if let Some(fallback) = &fallback {
        if fallback.provider == primary.provider && fallback.model == primary.model {
            return Err(format!(
                "{path}.fallback: a fallback to {} / {} is the primary route; \
                 declare a different provider or model, or remove it",
                primary.provider, primary.model,
            ));
        }
    }

    let declared = expect_block(&node.children, "capabilities", path, false)?
        .map(|child| capabilities(child, &format!("{path}.capabilities")))
        .transpose()?
        .filter(|declared| !declared.is_empty());

    Ok(RoleRoute {
        primary,
        fallback,
        capabilities: declared,
    })
}

/// Parse a capability block, used for both declarations and requirements.
fn capabilities(node: &Node, path: &str) -> Result<Capabilities, String> {
    expect_keys(
        &node.children,
        &["tools", "reasoning", "vision", "max_context"],
        path,
    )?;
    Ok(Capabilities {
        tools: flag(node, "tools", path)?,
        reasoning: flag(node, "reasoning", path)?,
        vision: flag(node, "vision", path)?,
        max_context: match expect_scalar(&node.children, "max_context", path, false)? {
            None => None,
            Some(value) => Some(value.parse::<u64>().map_err(|_| {
                format!("{path}.max_context: `{value}` is not a positive whole number of tokens")
            })?),
        },
    })
}

/// Read one boolean flag out of a capability block.
fn flag(node: &Node, key: &str, path: &str) -> Result<Option<bool>, String> {
    match expect_scalar(&node.children, key, path, false)? {
        None => Ok(None),
        Some("true") => Ok(Some(true)),
        Some("false") => Ok(Some(false)),
        Some(other) => Err(format!("{path}.{key}: `{other}` is not `true` or `false`")),
    }
}

/// Where the plan is read from, for the launch log.
///
/// @param workspace - the workspace root.
/// @returns the project configuration path, whether or not it exists.
pub fn project_config(workspace: &Path) -> PathBuf {
    workspace.join(crate::memory::PROJECT_CONFIG)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The block a test wants wrapped in a document.
    fn plan_of(block: &str) -> Result<Option<Plan>, String> {
        Plan::parse(&format!("memory:\n  project_id: twin\n{block}"))
    }

    #[test]
    fn an_absent_block_mounts_no_router() {
        assert_eq!(Plan::parse("memory:\n  project_id: twin\n").unwrap(), None,);
        assert_eq!(Plan::parse("").unwrap(), None);
    }

    #[test]
    fn manual_requires_exactly_one_selection_and_no_routing() {
        let plan = plan_of(
            "model_router:\n  mode: manual\n  manual:\n    provider: alpha\n    model: m1\n",
        )
        .unwrap()
        .unwrap();
        assert_eq!(plan.mode, Mode::Manual);
        let manual = plan.manual.unwrap();
        assert_eq!(manual.provider, "alpha");
        assert_eq!(manual.model, "m1");
        assert_eq!(manual.reasoning_effort, None);
        assert!(plan.roles.is_empty());

        // A manual mode without a selection is not a plan.
        let error = plan_of("model_router:\n  mode: manual\n").unwrap_err();
        assert!(error.contains("manual"), "{error}");
    }

    #[test]
    fn switch_requires_an_active_selection_that_can_be_replaced_later() {
        let plan = plan_of(
            "model_router:\n  mode: switch\n  active:\n    provider: alpha\n    model: m1\n    reasoning: high\n",
        )
        .unwrap()
        .unwrap();
        assert_eq!(plan.mode, Mode::Switch);
        assert_eq!(
            plan.active.unwrap().reasoning_effort.as_deref(),
            Some("high")
        );

        let error = plan_of("model_router:\n  mode: switch\n").unwrap_err();
        assert!(error.contains("active"), "{error}");
    }

    #[test]
    fn auto_reads_every_role_and_requires_a_default() {
        let plan = plan_of(
            "model_router:\n  mode: auto\n  roles:\n    fast:\n      provider: alpha\n      model: small\n    coding:\n      provider: alpha\n      model: big\n      reasoning: high\n      fallback:\n        provider: beta\n        model: other\n    default:\n      provider: alpha\n      model: mid\n",
        )
        .unwrap()
        .unwrap();
        assert_eq!(plan.mode, Mode::Auto);
        assert_eq!(plan.roles.len(), 3);
        assert_eq!(plan.roles["coding"].primary.model, "big");
        assert_eq!(
            plan.roles["coding"].fallback.as_ref().unwrap().provider,
            "beta"
        );
        assert_eq!(plan.roles["fast"].fallback, None);

        let error = plan_of(
            "model_router:\n  mode: auto\n  roles:\n    fast:\n      provider: a\n      model: b\n",
        )
        .unwrap_err();
        assert!(error.contains("roles.default"), "{error}");
    }

    #[test]
    fn requirements_are_read_per_role_and_may_address_an_unmapped_one() {
        let plan = plan_of(
            "model_router:\n  mode: auto\n  roles:\n    default:\n      provider: alpha\n      model: m1\n  requirements:\n    coding:\n      tools: true\n      reasoning: false\n      vision: true\n      max_context: 64000\n",
        )
        .unwrap()
        .unwrap();
        let coding = &plan.requirements["coding"];
        assert_eq!(coding.tools, Some(true));
        assert_eq!(coding.reasoning, Some(false));
        assert_eq!(coding.vision, Some(true));
        assert_eq!(coding.max_context, Some(64000));
    }

    #[test]
    fn a_route_may_declare_its_own_capabilities() {
        let plan = plan_of(
            "model_router:\n  mode: auto\n  roles:\n    default:\n      provider: alpha\n      model: m1\n      capabilities:\n        tools: true\n        vision: false\n",
        )
        .unwrap()
        .unwrap();
        let declared = plan.roles["default"].capabilities.clone().unwrap();
        assert_eq!(declared.tools, Some(true));
        assert_eq!(declared.vision, Some(false));
        assert_eq!(declared.max_context, None);
    }

    #[test]
    fn a_fallback_to_the_primary_route_is_refused() {
        let error = plan_of(
            "model_router:\n  mode: auto\n  roles:\n    default:\n      provider: alpha\n      model: m1\n      fallback:\n        provider: alpha\n        model: m1\n",
        )
        .unwrap_err();
        assert!(error.contains("primary route"), "{error}");
    }

    #[test]
    fn a_misspelled_key_is_refused_rather_than_ignored() {
        let error = plan_of("model_router:\n  mode: auto\n  modl: x\n").unwrap_err();
        assert!(error.contains("unknown key"), "{error}");
        assert!(error.contains("modl"), "{error}");

        let error = plan_of(
            "model_router:\n  mode: auto\n  roles:\n    default:\n      provider: a\n      modle: b\n",
        )
        .unwrap_err();
        assert!(error.contains("modle"), "{error}");

        let error = plan_of("model_router:\n  mode: sometimes\n").unwrap_err();
        assert!(error.contains("not a mode"), "{error}");
    }

    #[test]
    fn a_role_outside_the_vocabulary_is_refused_and_the_vocabulary_is_named() {
        let error = plan_of(
            "model_router:\n  mode: auto\n  roles:\n    wizardry:\n      provider: a\n      model: b\n",
        )
        .unwrap_err();
        assert!(error.contains("wizardry"), "{error}");
        assert!(
            error.contains("coding"),
            "the allowed roles must be named: {error}"
        );
    }

    #[test]
    fn a_credential_in_the_block_is_refused_and_pointed_at_the_settings() {
        for key in [
            "api_key",
            "apiKey",
            "provider_token",
            "password",
            "client_secret",
        ] {
            let error = plan_of(&format!(
                "model_router:\n  mode: manual\n  manual:\n    provider: a\n    model: b\n    {key}: sk-should-not-live-here\n",
            ))
            .unwrap_err();
            assert!(error.contains("credentials"), "{key}: {error}");
            assert!(error.contains("settings.yaml"), "{key}: {error}");
        }
    }

    #[test]
    fn a_malformed_document_is_refused_with_its_line() {
        // A scalar with children below it.
        let error = plan_of("model_router:\n  mode: auto\n    extra: 1\n").unwrap_err();
        assert!(error.contains("nested keys"), "{error}");
        // A line that is not a key/value pair at all.
        let error = plan_of("model_router:\n  mode auto\n").unwrap_err();
        assert!(error.contains("not a `key: value` line"), "{error}");
        // A tab as indentation.
        let error = plan_of("model_router:\n\tmode: auto\n").unwrap_err();
        assert!(error.contains("tab"), "{error}");
    }

    #[test]
    fn a_key_declared_twice_at_one_level_is_refused() {
        let error = plan_of("model_router:\n  mode: auto\n  mode: manual\n").unwrap_err();
        assert!(error.contains("twice"), "{error}");
    }

    #[test]
    fn a_section_declared_twice_is_refused_rather_than_merged() {
        let error = plan_of(
            "model_router:\n  mode: manual\n  manual:\n    provider: a\n    model: b\nmodel_router:\n  mode: auto\n",
        )
        .unwrap_err();
        assert!(error.contains("declared twice"), "{error}");
    }

    #[test]
    fn the_plan_serializes_to_the_contract_the_plugin_reads() {
        let plan = plan_of(
            "model_router:\n  mode: auto\n  roles:\n    coding:\n      provider: alpha\n      model: big\n      reasoning: high\n      fallback:\n        provider: beta\n        model: other\n      capabilities:\n        vision: true\n    default:\n      provider: alpha\n      model: mid\n  requirements:\n    coding:\n      tools: true\n      max_context: 64000\n",
        )
        .unwrap()
        .unwrap();
        let json: serde_json::Value = serde_json::from_str(&plan.to_json().unwrap()).unwrap();
        assert_eq!(json["mode"], "auto");
        assert_eq!(json["roles"]["coding"]["provider"], "alpha");
        assert_eq!(json["roles"]["coding"]["model"], "big");
        assert_eq!(json["roles"]["coding"]["reasoningEffort"], "high");
        assert_eq!(json["roles"]["coding"]["fallback"]["provider"], "beta");
        assert_eq!(json["roles"]["coding"]["capabilities"]["vision"], true);
        assert_eq!(json["requirements"]["coding"]["maxContext"], 64000);
        assert_eq!(json["roles"]["default"]["model"], "mid");
        // Absent fields must be absent, so a consumer can tell "not declared"
        // from "declared false".
        assert!(json["roles"]["default"].get("fallback").is_none());
        assert!(json.get("manual").is_none());
        assert!(json.get("active").is_none());
        // And no credential-shaped key can appear, at any depth.
        assert!(!json.to_string().contains("key"));
    }

    #[test]
    fn the_launcher_row_mounts_the_plugin_with_the_plan_as_one_scalar() {
        let layout = crate::memory::Layout::new(Path::new("/state"));
        let plan = plan_of(
            "model_router:\n  mode: manual\n  manual:\n    provider: alpha\n    model: m1\n",
        )
        .unwrap()
        .unwrap();
        let row = plan.row(&layout).unwrap();
        assert_eq!(row.id, ROW_ID);
        assert!(row.name.starts_with("file://"));
        assert!(row.name.ends_with("/plugins/model-router/index.js"));
        assert!(!row.disabled);
        assert_eq!(row.config.len(), 1);
        let carried: serde_json::Value =
            serde_json::from_str(row.config.get("plan").unwrap()).unwrap();
        assert_eq!(carried["mode"], "manual");
        assert_eq!(carried["manual"]["provider"], "alpha");
    }

    #[test]
    fn resolve_reads_the_projects_own_configuration_and_reports_a_bad_one() {
        let workspace = std::env::temp_dir().join("newpi-model-plan-test");
        let config = project_config(&workspace);
        // The path is fixed, so a previous run's file must not be read as this
        // run's state.
        let _ = std::fs::remove_dir_all(&workspace);
        std::fs::create_dir_all(config.parent().unwrap()).unwrap();

        // No file at all: no plan, no error.
        assert_eq!(Plan::resolve(&workspace).unwrap(), None);

        std::fs::write(&config, "memory:\n  project_id: twin\n").unwrap();
        assert_eq!(Plan::resolve(&workspace).unwrap(), None);

        std::fs::write(
            &config,
            "model_router:\n  mode: switch\n  active:\n    provider: alpha\n    model: m1\n",
        )
        .unwrap();
        let plan = Plan::resolve(&workspace).unwrap().unwrap();
        assert_eq!(plan.mode, Mode::Switch);

        std::fs::write(&config, "model_router:\n  mode: nonsense\n").unwrap();
        assert!(Plan::resolve(&workspace)
            .unwrap_err()
            .contains("not a mode"));

        std::fs::remove_dir_all(&workspace).unwrap();
    }
}
