# frozen_string_literal: true

# Unit test of the answer handling. Run: ruby test/formconfirmed_test.rb
require 'minitest/autorun'
require_relative '../formconfirmed'

class FormconfirmedTest < Minitest::Test
  CASES = [
    # [name, HTTP status, body, independent check, expected decision]
    ['allow', 200, '{"success":true,"score":0.9,"action":"allow","reasons":[],"error-codes":[]}', false, :deliver],
    ['flag', 200, '{"success":true,"score":0.5,"action":"flag","reasons":["too_fast"]}', false, :hold],
    ['flag + own check', 200, '{"success":true,"score":0.5,"action":"flag","reasons":["too_fast"]}', true, :hold],
    ['block', 200, '{"success":false,"action":"block","error-codes":["invalid-input-response"]}', false, :reject],
    ['browser outage claim', 200,
     '{"success":false,"score":0.35,"action":"flag","reasons":["service_unavailable"],"error-codes":["service-unavailable"]}', false, :hold],
    ['outage claim + own check', 200, '{"success":false,"action":"flag","reasons":["service_unavailable"]}', true, :deliver],
    ['outage claim with success', 200, '{"success":true,"action":"allow","reasons":["service_unavailable"]}', false, :hold],
    ['wrong secret', 200, '{"success":false,"action":"block","error-codes":["invalid-input-secret"]}', false, :hold],
    ['site paused', 200, '{"success":false,"action":"block","error-codes":["site-paused"]}', false, :hold],
    ['no answer', 0, '', false, :hold],
    ['HTTP 500', 500, '{"success":false}', false, :hold],
    ['not JSON', 200, '<html>maintenance</html>', false, :hold],
    ['unknown action', 200, '{"success":true,"action":"maybe"}', false, :hold],
    ['allow without success', 200, '{"success":false,"action":"allow"}', false, :hold],
    ['allow with string success', 200, '{"success":"true","action":"allow"}', false, :hold]
  ].freeze

  def test_cases
    CASES.each do |name, status, body, check, want|
      got = Formconfirmed.decide(Formconfirmed.read_answer(status, body)) { check }
      assert_equal want, got, name
    end
  end
end
