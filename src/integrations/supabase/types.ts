export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      app_settings: {
        Row: {
          description: string | null
          key: string
          updated_at: string
          user_id: string | null
          value: Json
        }
        Insert: {
          description?: string | null
          key: string
          updated_at?: string
          user_id?: string | null
          value?: Json
        }
        Update: {
          description?: string | null
          key?: string
          updated_at?: string
          user_id?: string | null
          value?: Json
        }
        Relationships: []
      }
      cash_positions: {
        Row: {
          account_name: string
          account_type: string
          balance_eur: number
          created_at: string
          currency: string
          id: string
          notes: string | null
          updated_at: string
          user_id: string | null
        }
        Insert: {
          account_name: string
          account_type?: string
          balance_eur?: number
          created_at?: string
          currency?: string
          id?: string
          notes?: string | null
          updated_at?: string
          user_id?: string | null
        }
        Update: {
          account_name?: string
          account_type?: string
          balance_eur?: number
          created_at?: string
          currency?: string
          id?: string
          notes?: string | null
          updated_at?: string
          user_id?: string | null
        }
        Relationships: []
      }
      data_cache: {
        Row: {
          cache_key: string
          fetched_at: string | null
          payload: Json
          provider: string
        }
        Insert: {
          cache_key: string
          fetched_at?: string | null
          payload: Json
          provider: string
        }
        Update: {
          cache_key?: string
          fetched_at?: string | null
          payload?: Json
          provider?: string
        }
        Relationships: []
      }
      integrations: {
        Row: {
          access_token: string
          created_at: string | null
          expires_at: string | null
          id: string
          metadata: Json | null
          provider: string
          refresh_token: string | null
          updated_at: string | null
          user_id: string | null
        }
        Insert: {
          access_token: string
          created_at?: string | null
          expires_at?: string | null
          id?: string
          metadata?: Json | null
          provider: string
          refresh_token?: string | null
          updated_at?: string | null
          user_id?: string | null
        }
        Update: {
          access_token?: string
          created_at?: string | null
          expires_at?: string | null
          id?: string
          metadata?: Json | null
          provider?: string
          refresh_token?: string | null
          updated_at?: string | null
          user_id?: string | null
        }
        Relationships: []
      }
      inventory_positions: {
        Row: {
          created_at: string
          id: string
          location: string
          name: string
          notes: string | null
          pieces: number
          sku: string
          unit_cost_eur: number
          updated_at: string
          user_id: string | null
        }
        Insert: {
          created_at?: string
          id?: string
          location?: string
          name: string
          notes?: string | null
          pieces?: number
          sku: string
          unit_cost_eur?: number
          updated_at?: string
          user_id?: string | null
        }
        Update: {
          created_at?: string
          id?: string
          location?: string
          name?: string
          notes?: string | null
          pieces?: number
          sku?: string
          unit_cost_eur?: number
          updated_at?: string
          user_id?: string | null
        }
        Relationships: []
      }
      loop_sync_errors: {
        Row: {
          first_seen_at: string
          last_error: string | null
          last_seen_at: string
          market: string
          resolved_at: string | null
          retry_count: number
          status: string
        }
        Insert: {
          first_seen_at?: string
          last_error?: string | null
          last_seen_at?: string
          market: string
          resolved_at?: string | null
          retry_count?: number
          status: string
        }
        Update: {
          first_seen_at?: string
          last_error?: string | null
          last_seen_at?: string
          market?: string
          resolved_at?: string | null
          retry_count?: number
          status?: string
        }
        Relationships: []
      }
      loop_sync_runs: {
        Row: {
          duration_ms: number | null
          finished_at: string | null
          id: string
          last_error: string | null
          market: string
          outcome: string
          pages_fetched: number
          per_status: Json
          rows_upserted: number
          run_group_id: string
          started_at: string
          total_fetched: number
        }
        Insert: {
          duration_ms?: number | null
          finished_at?: string | null
          id?: string
          last_error?: string | null
          market: string
          outcome?: string
          pages_fetched?: number
          per_status?: Json
          rows_upserted?: number
          run_group_id?: string
          started_at?: string
          total_fetched?: number
        }
        Update: {
          duration_ms?: number | null
          finished_at?: string | null
          id?: string
          last_error?: string | null
          market?: string
          outcome?: string
          pages_fetched?: number
          per_status?: Json
          rows_upserted?: number
          run_group_id?: string
          started_at?: string
          total_fetched?: number
        }
        Relationships: []
      }
      loop_sync_state: {
        Row: {
          done: boolean
          last_error: string | null
          last_error_at: string | null
          last_success_at: string | null
          market: string
          page_no: number
          retry_count: number
          started_at: string
          status: string
          total_fetched: number
          updated_at: string
        }
        Insert: {
          done?: boolean
          last_error?: string | null
          last_error_at?: string | null
          last_success_at?: string | null
          market: string
          page_no?: number
          retry_count?: number
          started_at?: string
          status: string
          total_fetched?: number
          updated_at?: string
        }
        Update: {
          done?: boolean
          last_error?: string | null
          last_error_at?: string | null
          last_success_at?: string | null
          market?: string
          page_no?: number
          retry_count?: number
          started_at?: string
          status?: string
          total_fetched?: number
          updated_at?: string
        }
        Relationships: []
      }
      shopify_orders: {
        Row: {
          currency: string | null
          customer_id: string | null
          customer_lifetime_orders: number | null
          financial_status: string | null
          fulfillment_status: string | null
          id: string
          order_number: number | null
          processed_at: string | null
          raw: Json | null
          shop_domain: string
          shopify_created_at: string
          shopify_updated_at: string
          store_code: string
          subtotal_price: number | null
          synced_at: string
          total_discounts: number | null
          total_price: number | null
          total_refunded: number | null
          total_shipping: number | null
          total_tax: number | null
        }
        Insert: {
          currency?: string | null
          customer_id?: string | null
          customer_lifetime_orders?: number | null
          financial_status?: string | null
          fulfillment_status?: string | null
          id: string
          order_number?: number | null
          processed_at?: string | null
          raw?: Json | null
          shop_domain: string
          shopify_created_at: string
          shopify_updated_at: string
          store_code: string
          subtotal_price?: number | null
          synced_at?: string
          total_discounts?: number | null
          total_price?: number | null
          total_refunded?: number | null
          total_shipping?: number | null
          total_tax?: number | null
        }
        Update: {
          currency?: string | null
          customer_id?: string | null
          customer_lifetime_orders?: number | null
          financial_status?: string | null
          fulfillment_status?: string | null
          id?: string
          order_number?: number | null
          processed_at?: string | null
          raw?: Json | null
          shop_domain?: string
          shopify_created_at?: string
          shopify_updated_at?: string
          store_code?: string
          subtotal_price?: number | null
          synced_at?: string
          total_discounts?: number | null
          total_price?: number | null
          total_refunded?: number | null
          total_shipping?: number | null
          total_tax?: number | null
        }
        Relationships: []
      }
      shopify_sync_state: {
        Row: {
          backfill_complete: boolean
          last_cursor: string | null
          last_run_at: string | null
          last_run_message: string | null
          last_run_status: string | null
          last_updated_at: string | null
          shop_domain: string
          store_code: string
          total_orders: number
          updated_at: string
        }
        Insert: {
          backfill_complete?: boolean
          last_cursor?: string | null
          last_run_at?: string | null
          last_run_message?: string | null
          last_run_status?: string | null
          last_updated_at?: string | null
          shop_domain: string
          store_code: string
          total_orders?: number
          updated_at?: string
        }
        Update: {
          backfill_complete?: boolean
          last_cursor?: string | null
          last_run_at?: string | null
          last_run_message?: string | null
          last_run_status?: string | null
          last_updated_at?: string | null
          shop_domain?: string
          store_code?: string
          total_orders?: number
          updated_at?: string
        }
        Relationships: []
      }
      subscription_snapshots: {
        Row: {
          id: string
          payload: Json
          provider: string
          store_code: string
          taken_at: string
        }
        Insert: {
          id?: string
          payload: Json
          provider: string
          store_code: string
          taken_at?: string
        }
        Update: {
          id?: string
          payload?: Json
          provider?: string
          store_code?: string
          taken_at?: string
        }
        Relationships: []
      }
      UK_loop: {
        Row: {
          attributes: Json | null
          billing_policy: Json | null
          cancellation_comment: string | null
          cancellation_reason: string | null
          cancelled_at: string | null
          completed_orders_count: number | null
          created_at: string | null
          currency_code: string | null
          delivery_method: Json | null
          delivery_policy: Json | null
          delivery_price: number | null
          id: number
          is_marked_for_cancellation: boolean | null
          is_prepaid: boolean | null
          last_inventory_action: string | null
          last_payment_status: string | null
          lines: Json | null
          next_billing_date_epoch: number | null
          order_note: string | null
          origin_order_shopify_id: number | null
          paused_at: string | null
          raw: Json
          shipping_address: Json | null
          shopify_id: number | null
          status: string | null
          synced_at: string
          total_line_item_discounted_price: number | null
          total_line_item_price: number | null
          updated_at: string | null
        }
        Insert: {
          attributes?: Json | null
          billing_policy?: Json | null
          cancellation_comment?: string | null
          cancellation_reason?: string | null
          cancelled_at?: string | null
          completed_orders_count?: number | null
          created_at?: string | null
          currency_code?: string | null
          delivery_method?: Json | null
          delivery_policy?: Json | null
          delivery_price?: number | null
          id: number
          is_marked_for_cancellation?: boolean | null
          is_prepaid?: boolean | null
          last_inventory_action?: string | null
          last_payment_status?: string | null
          lines?: Json | null
          next_billing_date_epoch?: number | null
          order_note?: string | null
          origin_order_shopify_id?: number | null
          paused_at?: string | null
          raw: Json
          shipping_address?: Json | null
          shopify_id?: number | null
          status?: string | null
          synced_at?: string
          total_line_item_discounted_price?: number | null
          total_line_item_price?: number | null
          updated_at?: string | null
        }
        Update: {
          attributes?: Json | null
          billing_policy?: Json | null
          cancellation_comment?: string | null
          cancellation_reason?: string | null
          cancelled_at?: string | null
          completed_orders_count?: number | null
          created_at?: string | null
          currency_code?: string | null
          delivery_method?: Json | null
          delivery_policy?: Json | null
          delivery_price?: number | null
          id?: number
          is_marked_for_cancellation?: boolean | null
          is_prepaid?: boolean | null
          last_inventory_action?: string | null
          last_payment_status?: string | null
          lines?: Json | null
          next_billing_date_epoch?: number | null
          order_note?: string | null
          origin_order_shopify_id?: number | null
          paused_at?: string | null
          raw?: Json
          shipping_address?: Json | null
          shopify_id?: number | null
          status?: string | null
          synced_at?: string
          total_line_item_discounted_price?: number | null
          total_line_item_price?: number | null
          updated_at?: string | null
        }
        Relationships: []
      }
      US_loop: {
        Row: {
          attributes: Json | null
          billing_policy: Json | null
          cancellation_comment: string | null
          cancellation_reason: string | null
          cancelled_at: string | null
          completed_orders_count: number | null
          created_at: string | null
          currency_code: string | null
          delivery_method: Json | null
          delivery_policy: Json | null
          delivery_price: number | null
          id: number
          is_marked_for_cancellation: boolean | null
          is_prepaid: boolean | null
          last_inventory_action: string | null
          last_payment_status: string | null
          lines: Json | null
          next_billing_date_epoch: number | null
          order_note: string | null
          origin_order_shopify_id: number | null
          paused_at: string | null
          raw: Json
          shipping_address: Json | null
          shopify_id: number | null
          status: string | null
          synced_at: string
          total_line_item_discounted_price: number | null
          total_line_item_price: number | null
          updated_at: string | null
        }
        Insert: {
          attributes?: Json | null
          billing_policy?: Json | null
          cancellation_comment?: string | null
          cancellation_reason?: string | null
          cancelled_at?: string | null
          completed_orders_count?: number | null
          created_at?: string | null
          currency_code?: string | null
          delivery_method?: Json | null
          delivery_policy?: Json | null
          delivery_price?: number | null
          id: number
          is_marked_for_cancellation?: boolean | null
          is_prepaid?: boolean | null
          last_inventory_action?: string | null
          last_payment_status?: string | null
          lines?: Json | null
          next_billing_date_epoch?: number | null
          order_note?: string | null
          origin_order_shopify_id?: number | null
          paused_at?: string | null
          raw: Json
          shipping_address?: Json | null
          shopify_id?: number | null
          status?: string | null
          synced_at?: string
          total_line_item_discounted_price?: number | null
          total_line_item_price?: number | null
          updated_at?: string | null
        }
        Update: {
          attributes?: Json | null
          billing_policy?: Json | null
          cancellation_comment?: string | null
          cancellation_reason?: string | null
          cancelled_at?: string | null
          completed_orders_count?: number | null
          created_at?: string | null
          currency_code?: string | null
          delivery_method?: Json | null
          delivery_policy?: Json | null
          delivery_price?: number | null
          id?: number
          is_marked_for_cancellation?: boolean | null
          is_prepaid?: boolean | null
          last_inventory_action?: string | null
          last_payment_status?: string | null
          lines?: Json | null
          next_billing_date_epoch?: number | null
          order_note?: string | null
          origin_order_shopify_id?: number | null
          paused_at?: string | null
          raw?: Json
          shipping_address?: Json | null
          shopify_id?: number | null
          status?: string | null
          synced_at?: string
          total_line_item_discounted_price?: number | null
          total_line_item_price?: number | null
          updated_at?: string | null
        }
        Relationships: []
      }
      user_roles: {
        Row: {
          created_at: string
          id: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          user_id?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
    }
    Enums: {
      app_role: "admin" | "moderator" | "user"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      app_role: ["admin", "moderator", "user"],
    },
  },
} as const
