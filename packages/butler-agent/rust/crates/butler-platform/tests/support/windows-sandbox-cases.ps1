function Get-MatrixCases {
    return @(
        @(0,'language::language_policy_probe'),
        @(1,'project_boundaries::row01_project_and_scratch'),
        @(2,'project_boundaries::row02_outside_writes'),
        @(3,'project_boundaries::row03_secret_contents_ads_and_parent_delete'),
        @(4,'tools::row04_git'), @(5,'boundaries::row05_credentials'),
        @(6,'boundaries::row06_registry_tasks_wmi'), @(7,'boundaries::row07_alias_escapes'),
        @(8,'project_boundaries::row08_ancestor_sibling_listings'),
        @(9,'boundaries::row09_network'), @(10,'tools::row10_toolchains_unicode_long_path'),
        @(11,'project_write::row11_new_secrets_are_swept'),
        @(12,'project_write::row12_timeout_and_agent_kill'), @(14,'latency::row14_latency'),
        @(15,'access_tiers::auto::auto_works_in_the_project_and_asks_for_risky_steps'),
        @(17,'setting::row17_command_sandbox_setting')
    )
}
