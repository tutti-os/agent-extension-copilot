#!/usr/bin/env python3
"""Validate a declarative Tutti Agent Extension package without network access."""

from __future__ import annotations

import argparse
import json
import mimetypes
import os
import re
import stat
import sys
import xml.etree.ElementTree as ET
from pathlib import Path, PurePosixPath
from typing import Any

MANIFEST_SCHEMA = "tutti.agent.manifest.v2"
PROFILE_SCHEMAS = {
    "discovery": "tutti.agent.discovery.v1",
    "tools": "tutti.agent.tools.v1",
    "capabilities": "tutti.agent.capabilities.v1",
    "composer": "tutti.agent.composer.v1",
}
SEMVER = re.compile(r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$")
EXACT_NPM_PACKAGE = re.compile(
    r"^(?:@[a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._-]*@"
    r"(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$"
)
EXACT_UV_PACKAGE = re.compile(
    r"^[A-Za-z0-9][A-Za-z0-9._-]*=="
    r"(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:[A-Za-z0-9._+-]*)?$"
)
BINARY_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
PRESENTATION_ASSET_LIMIT = 256 << 10
ALLOWED_PACKAGE_SUFFIXES = {".json", ".md", ".svg", ".png", ".jpg", ".jpeg", ".webp"}
PACKAGE_DOCUMENTATION = {"AGENTS.md"}
PASSIVE_SVG_ELEMENTS = {
    "circle",
    "defs",
    "desc",
    "g",
    "linearGradient",
    "path",
    "rect",
    "stop",
    "svg",
    "text",
    "title",
}
PERMISSION_SEMANTICS = {
    "read-only",
    "ask-before-write",
    "accept-edits",
    "full-access",
}


class ValidationError(Exception):
    pass


def require_only_keys(value: dict[str, Any], allowed: set[str], field: str) -> None:
    for key in value:
        if key not in allowed:
            raise ValidationError(f"{field} contains unsupported field {key}")


def read_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ValidationError(f"cannot read JSON {path}: {exc}") from exc
    if not isinstance(value, dict):
        raise ValidationError(f"expected JSON object: {path}")
    return value


def require_string(value: Any, field: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValidationError(f"{field} must be a non-empty string")
    return value


def require_string_array(
    value: Any, field: str, *, non_empty: bool = False
) -> list[str]:
    if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
        raise ValidationError(f"{field} must be a string array")
    if non_empty and not value:
        raise ValidationError(f"{field} must not be empty")
    return value


def require_safe_relative_path(value: Any, field: str) -> str:
    path = require_string(value, field)
    pure = PurePosixPath(path)
    if pure.is_absolute() or ".." in pure.parts or "\\" in path:
        raise ValidationError(f"{field} must be a safe relative POSIX path")
    return path


def resolve_reference(root: Path, value: Any, field: str) -> Path:
    reference = require_string(value, field)
    pure = PurePosixPath(reference)
    if pure.is_absolute() or ".." in pure.parts or "\\" in reference:
        raise ValidationError(f"{field} must be a safe relative POSIX path")
    resolved = (root / Path(*pure.parts)).resolve()
    try:
        resolved.relative_to(root.resolve())
    except ValueError as exc:
        raise ValidationError(f"{field} escapes package root") from exc
    if not resolved.is_file():
        raise ValidationError(f"{field} does not exist: {reference}")
    return resolved


def validate_presentation_asset(root: Path, descriptor: Any, field: str) -> Path:
    if not isinstance(descriptor, dict) or descriptor.get("type") != "asset":
        raise ValidationError(f"{field} must be an extension asset")
    path = resolve_reference(root, descriptor.get("src"), f"{field}.src")
    if path.stat().st_size > PRESENTATION_ASSET_LIMIT:
        raise ValidationError(f"{field} exceeds the 256 KiB presentation asset limit")
    content_type, _ = mimetypes.guess_type(path.name)
    if not content_type or not content_type.startswith("image/"):
        raise ValidationError(f"{field} must use a supported image file type")
    if path.suffix.lower() == ".svg":
        try:
            contents = path.read_text(encoding="utf-8")
        except UnicodeDecodeError as exc:
            raise ValidationError(f"{field} SVG must be valid UTF-8") from exc
        validate_passive_svg(contents, field)
    return path


def validate_passive_svg(contents: str, field: str) -> None:
    lower = contents.lower()
    if any(token in lower for token in ("<!doctype", "<!entity", "<style")):
        raise ValidationError(f"{field} SVG contains active or remote content")
    if re.search(r"\son[a-z0-9_.:-]*\s*=", lower):
        raise ValidationError(f"{field} SVG contains an event handler")
    if re.search(r"\b(?:href|src)\s*=", lower):
        raise ValidationError(f"{field} SVG contains an external-reference attribute")
    for match in re.finditer(r"url\(([^)]*)\)", contents, flags=re.IGNORECASE):
        value = match.group(1).strip().strip("\"'")
        if not re.fullmatch(r"#[A-Za-z_][A-Za-z0-9_.:-]*", value):
            raise ValidationError(f"{field} SVG contains a remote URL reference")
    try:
        root = ET.fromstring(contents)
    except ET.ParseError as exc:
        raise ValidationError(f"{field} SVG must be well-formed XML") from exc
    for element in root.iter():
        tag = element.tag.rsplit("}", 1)[-1]
        if tag not in PASSIVE_SVG_ELEMENTS:
            raise ValidationError(f"{field} SVG element is not passive: {tag}")
        for attribute in element.attrib:
            name = attribute.rsplit("}", 1)[-1].lower()
            if name.startswith("on") or name in {"href", "src", "style"}:
                raise ValidationError(
                    f"{field} SVG attribute is not passive: {name}"
                )


def check_package_tree(root: Path) -> None:
    for path in root.rglob("*"):
        relative = path.relative_to(root)
        relative_text = relative.as_posix()
        if any(character in relative_text for character in ("\\", "\n", "\r", "\0")):
            raise ValidationError(f"unsafe package path: {relative_text!r}")
        if path.is_symlink():
            raise ValidationError(f"symlinks are not allowed: {relative}")
        mode = path.stat().st_mode
        if path.is_file() and mode & (stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH):
            raise ValidationError(f"executable files are not allowed: {relative}")
        if path.is_file() and path.suffix.lower() not in ALLOWED_PACKAGE_SUFFIXES:
            raise ValidationError(f"unsupported package file type: {relative}")
        if any(part in {".git", "node_modules"} for part in relative.parts):
            raise ValidationError(f"development directory is not allowed: {relative}")


def check_declared_files(root: Path, manifest: dict[str, Any]) -> None:
    declared = {"tutti.agent.json"}
    declared.update(name for name in PACKAGE_DOCUMENTATION if (root / name).is_file())
    declared.add(require_safe_relative_path(manifest["icon"]["src"], "icon.src"))
    if manifest.get("maskIcon") is not None:
        declared.add(
            require_safe_relative_path(
                manifest["maskIcon"]["src"], "maskIcon.src"
            )
        )
    declared.add(require_safe_relative_path(manifest["heroImage"]["src"], "heroImage.src"))
    declared.update(
        require_safe_relative_path(value, f"profiles.{name}")
        for name, value in manifest["profiles"].items()
    )
    localization = manifest["localizationInfo"]
    declared.add(
        require_safe_relative_path(
            localization["defaultFile"], "localizationInfo.defaultFile"
        )
    )
    declared.update(
        require_safe_relative_path(locale["file"], "additional locale file")
        for locale in localization.get("additionalLocales", [])
    )
    actual = {
        path.relative_to(root).as_posix()
        for path in root.rglob("*")
        if path.is_file() and not path.is_symlink()
    }
    undeclared = sorted(actual - declared)
    if undeclared:
        raise ValidationError(
            f"package contains undeclared file: {undeclared[0]}"
        )


def check_install(runtime: dict[str, Any]) -> None:
    require_only_keys(runtime, {"kind", "install", "launch"}, "runtime")
    if runtime.get("kind") != "standard-acp":
        raise ValidationError("runtime.kind must be standard-acp")
    install = runtime.get("install")
    launch = runtime.get("launch")
    if not isinstance(install, dict) or not isinstance(launch, dict):
        raise ValidationError("runtime.install and runtime.launch must be objects")
    require_only_keys(install, {"runner", "args"}, "runtime.install")
    require_only_keys(launch, {"executable", "args"}, "runtime.launch")
    runner = install.get("runner")
    if runner not in {"npm", "pnpm", "uv"}:
        raise ValidationError("runtime.install.runner must be npm, pnpm, or uv")
    args = require_string_array(
        install.get("args"), "runtime.install.args", non_empty=True
    )
    package_pattern = EXACT_UV_PACKAGE if runner == "uv" else EXACT_NPM_PACKAGE
    expected_prefix = {
        "npm": ["install", "--prefix", "${installRoot}"],
        "pnpm": ["add", "--dir", "${installRoot}"],
        "uv": ["pip", "install", "--target", "${installRoot}"],
    }[runner]
    if (
        len(args) != len(expected_prefix) + 1
        or args[:-1] != expected_prefix
        or not package_pattern.fullmatch(args[-1])
    ):
        syntax = "package==version" if runner == "uv" else "package@version"
        raise ValidationError(
            f"runtime install must use the safe local {runner} form with one exact {syntax}"
        )
    executable = require_string(launch.get("executable"), "runtime.launch.executable")
    if (
        not executable.startswith("${installRoot}/")
        or ".." in PurePosixPath(executable).parts
    ):
        raise ValidationError("launch executable must stay under ${installRoot}")
    require_string_array(launch.get("args"), "runtime.launch.args")


def validate_discovery_profile(profile: dict[str, Any]) -> None:
    candidates = profile.get("candidates")
    if not isinstance(candidates, list) or not candidates:
        raise ValidationError("discovery.candidates must be a non-empty array")
    for index, candidate in enumerate(candidates):
        field = f"discovery.candidates[{index}]"
        if not isinstance(candidate, dict):
            raise ValidationError(f"{field} must be an object")
        binaries = require_string_array(
            candidate.get("binaryNames"), f"{field}.binaryNames", non_empty=True
        )
        if any(not BINARY_NAME.fullmatch(binary) for binary in binaries):
            raise ValidationError(
                f"{field}.binaryNames contains an invalid binary name"
            )
        version = candidate.get("version")
        if not isinstance(version, dict):
            raise ValidationError(f"{field}.version must be an object")
        require_string_array(
            version.get("args"), f"{field}.version.args", non_empty=True
        )
        require_string(version.get("constraint"), f"{field}.version.constraint")
        require_string_array(candidate.get("launchArgs"), f"{field}.launchArgs")
        probe = candidate.get("probe")
        if not isinstance(probe, dict) or probe.get("kind") != "acp-initialize":
            raise ValidationError(f"{field}.probe.kind must be acp-initialize")
        timeout_ms = probe.get("timeoutMs")
        if not isinstance(timeout_ms, int) or not 100 <= timeout_ms <= 60_000:
            raise ValidationError(f"{field}.probe.timeoutMs must be 100..60000")


def validate_tools_profile(profile: dict[str, Any]) -> None:
    tools = profile.get("tools")
    if not isinstance(tools, list):
        raise ValidationError("tools.tools must be an array")
    for index, tool in enumerate(tools):
        field = f"tools.tools[{index}]"
        if not isinstance(tool, dict):
            raise ValidationError(f"{field} must be an object")
        require_string(tool.get("name"), f"{field}.name")
        if "aliases" in tool:
            require_string_array(tool["aliases"], f"{field}.aliases")


def validate_capabilities_profile(profile: dict[str, Any]) -> dict[str, bool]:
    declared = profile.get("declared")
    if not isinstance(declared, dict):
        raise ValidationError("capabilities.declared must be an object")
    if not all(
        isinstance(key, str) and isinstance(value, bool)
        for key, value in declared.items()
    ):
        raise ValidationError("capabilities.declared values must be booleans")
    return declared


def validate_skill_root(root: Any, index: int) -> None:
    field = f"composer.skills.roots[{index}]"
    if not isinstance(root, dict):
        raise ValidationError(f"{field} must be an object")
    if root.get("scope") not in {"workspace", "user"}:
        raise ValidationError(f"{field}.scope must be workspace or user")
    require_safe_relative_path(root.get("path"), f"{field}.path")


def validate_composer_profile(profile: dict[str, Any]) -> bool:
    model = profile.get("model")
    if not isinstance(model, dict) or model.get("source") != "acp-session-models":
        raise ValidationError("composer.model.source must be acp-session-models")
    permission = profile.get("permission")
    if (
        not isinstance(permission, dict)
        or permission.get("source") != "acp-session-modes"
    ):
        raise ValidationError("composer.permission.source must be acp-session-modes")
    modes = profile.get("permissionModes")
    if not isinstance(modes, list):
        raise ValidationError("composer.permissionModes must be an array")
    runtime_ids: set[str] = set()
    for index, mode in enumerate(modes):
        field = f"composer.permissionModes[{index}]"
        if not isinstance(mode, dict):
            raise ValidationError(f"{field} must be an object")
        runtime_id = require_string(mode.get("runtimeId"), f"{field}.runtimeId").strip()
        if runtime_id in runtime_ids:
            raise ValidationError(f"{field}.runtimeId must be unique")
        runtime_ids.add(runtime_id)
        if mode.get("semantic") not in PERMISSION_SEMANTICS:
            raise ValidationError(f"{field}.semantic is unsupported")
    skills = profile.get("skills")
    if skills is None:
        return False
    if not isinstance(skills, dict):
        raise ValidationError("composer.skills must be an object")
    if skills.get("invocation") != "textTrigger":
        raise ValidationError("composer.skills.invocation must be textTrigger")
    trigger = require_string(
        skills.get("triggerPrefix"), "composer.skills.triggerPrefix"
    )
    if any(character.isspace() for character in trigger) or len(trigger) > 8:
        raise ValidationError(
            "composer.skills.triggerPrefix must be a short non-space prefix"
        )
    roots = skills.get("roots")
    if not isinstance(roots, list) or not roots:
        raise ValidationError("composer.skills.roots must be a non-empty array")
    for index, root in enumerate(roots):
        validate_skill_root(root, index)
    return True


def validate_profiles(profile_values: dict[str, dict[str, Any]]) -> None:
    validate_discovery_profile(profile_values["discovery"])
    validate_tools_profile(profile_values["tools"])
    capabilities = validate_capabilities_profile(profile_values["capabilities"])
    composer_has_skills = validate_composer_profile(profile_values["composer"])
    if bool(capabilities.get("skills")) != composer_has_skills:
        raise ValidationError(
            "capabilities.declared.skills must match the composer.skills declaration"
        )


def validate(root: Path) -> None:
    root = root.resolve()
    manifest_path = root / "tutti.agent.json"
    if not root.is_dir() or not manifest_path.is_file():
        raise ValidationError(f"package must contain tutti.agent.json: {root}")
    check_package_tree(root)
    manifest = read_json(manifest_path)
    require_only_keys(
        manifest,
        {
            "schemaVersion",
            "agentKey",
            "version",
            "name",
            "description",
            "icon",
            "maskIcon",
            "heroImage",
            "runtime",
            "profiles",
            "localizationInfo",
        },
        "manifest",
    )
    if manifest.get("schemaVersion") != MANIFEST_SCHEMA:
        raise ValidationError(f"schemaVersion must be {MANIFEST_SCHEMA}")
    require_string(manifest.get("agentKey"), "agentKey")
    version = require_string(manifest.get("version"), "version")
    if not SEMVER.fullmatch(version):
        raise ValidationError("version must be semantic versioning without a range")
    require_string(manifest.get("name"), "name")
    require_string(manifest.get("description"), "description")

    runtime = manifest.get("runtime")
    if not isinstance(runtime, dict):
        raise ValidationError("runtime must be an object")
    check_install(runtime)

    validate_presentation_asset(root, manifest.get("icon"), "icon")
    if manifest.get("maskIcon") is not None:
        validate_presentation_asset(root, manifest.get("maskIcon"), "maskIcon")
    validate_presentation_asset(root, manifest.get("heroImage"), "heroImage")
    require_only_keys(manifest["icon"], {"type", "src"}, "icon")
    if manifest.get("maskIcon") is not None:
        require_only_keys(
            manifest["maskIcon"], {"type", "src"}, "maskIcon"
        )
    require_only_keys(manifest["heroImage"], {"type", "src"}, "heroImage")

    profiles = manifest.get("profiles")
    if not isinstance(profiles, dict):
        raise ValidationError("profiles must be an object")
    require_only_keys(profiles, set(PROFILE_SCHEMAS), "profiles")
    profile_values: dict[str, dict[str, Any]] = {}
    for profile_name, schema in PROFILE_SCHEMAS.items():
        profile_path = resolve_reference(
            root, profiles.get(profile_name), f"profiles.{profile_name}"
        )
        profile = read_json(profile_path)
        if profile.get("schemaVersion") != schema:
            raise ValidationError(f"profiles.{profile_name} must use {schema}")
        profile_values[profile_name] = profile
    validate_profiles(profile_values)

    localization = manifest.get("localizationInfo")
    if not isinstance(localization, dict):
        raise ValidationError("localizationInfo must be an object")
    require_only_keys(
        localization,
        {"defaultLocale", "defaultFile", "additionalLocales"},
        "localizationInfo",
    )
    locale_files = [
        resolve_reference(
            root, localization.get("defaultFile"), "localizationInfo.defaultFile"
        )
    ]
    additional = localization.get("additionalLocales", [])
    if not isinstance(additional, list):
        raise ValidationError("localizationInfo.additionalLocales must be an array")
    for index, locale in enumerate(additional):
        if not isinstance(locale, dict):
            raise ValidationError(f"additionalLocales[{index}] must be an object")
        require_only_keys(
            locale, {"locale", "file"}, f"additionalLocales[{index}]"
        )
        require_string(locale.get("locale"), f"additionalLocales[{index}].locale")
        locale_files.append(
            resolve_reference(
                root, locale.get("file"), f"additionalLocales[{index}].file"
            )
        )
    for locale_file in locale_files:
        locale = read_json(locale_file)
        require_string(locale.get("agent.name"), f"{locale_file.name}.agent.name")
        require_string(
            locale.get("agent.description"), f"{locale_file.name}.agent.description"
        )
    check_declared_files(root, manifest)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "package", type=Path, help="Directory containing tutti.agent.json"
    )
    args = parser.parse_args()
    try:
        validate(args.package)
    except ValidationError as exc:
        print(f"validation failed: {exc}", file=sys.stderr)
        return 1
    print(json.dumps({"status": "ok", "package": os.fspath(args.package.resolve())}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
